import crypto from "crypto";
import { query as dbQuery } from "./db.js";
import { config } from "./config.js";

// =============================
// Types
// =============================

export interface ApiKeyRecord {
  id: string;
  organization_id: number | null;
  hashed_key: string;
  privilege_level: number;
  valid_until: number; // Unix timestamp, 0 = no expiration
  created_at: number;
  last_used: number | null;
  status: "active" | "disabled" | "expired";
  username: string;
}

export interface ApiKeyMetadata {
  id: string;
  key_prefix: string;
  organization_id: number | null;
  organization_slug?: string | null;
  organization_name?: string | null;
  username: string;
  privilege_level: number;
  status: string;
  valid_until: number;
  last_used: number | null;
  created_at: number;
  project_ids: number[];
}

export interface DecodedKey {
  key: string;
  valid: boolean;
  record?: ApiKeyRecord;
  error?: string;
}

export interface OrganizationRecord {
  organization_id: number;
  slug: string;
  name: string;
  created_at?: string;
}

export interface ProjectRecord {
  project_id: number;
  organization_id: number;
  slug: string;
  name: string;
  description?: string | null;
  document_count?: number;
  created_at?: string;
}

export interface ApiKeyProjectAccessRecord {
  api_key_id: string;
  project_id: number;
  organization_id: number;
  project_slug: string;
  project_name: string;
}

// =============================
// Constants
// =============================

const HMAC_ALGORITHM = "sha256";
const KEY_PREFIX_LENGTH = 8;

if (!config.API_KEY_SECRET) {
  throw new Error("API_KEY_SECRET is required for API key hashing.");
}


// =============================
// Helpers
// =============================

const toNumberOrNull = (value: any): number | null => {
  if (value === null || value === undefined) return null;
  return Number(value);
};

const normalizeProjectIds = (projectIds: unknown): number[] => {
  if (!Array.isArray(projectIds)) return [];
  const unique = new Set<number>();
  for (const raw of projectIds) {
    const num = Number(raw);
    if (Number.isInteger(num) && num > 0) {
      unique.add(num);
    }
  }
  return Array.from(unique.values());
};

const deriveSlugFromName = (value: string): string => {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized.slice(0, 120);
};

const resolveApiKeyById = async (keyId: string): Promise<ApiKeyRecord | null> => {
  const rows = await dbQuery(
    `SELECT * FROM \`${config.MARIADB_DATABASE}\`.\`${config.DB_TABLE_KEYS}\` WHERE id = ? LIMIT 1`,
    [keyId]
  );
  if (!rows.length) return null;
  const r = rows[0] as any;
  return {
    id: String(r.id),
    organization_id: toNumberOrNull(r.organization_id),
    hashed_key: String(r.hashed_key),
    privilege_level: Number(r.privilege_level),
    valid_until: Number(r.valid_until),
    created_at: Number(r.created_at),
    last_used: toNumberOrNull(r.last_used),
    status: r.status,
    username: String(r.username),
  };
};

const assertProjectsBelongToOrganization = async (organizationId: number, projectIds: number[]): Promise<void> => {
  if (!projectIds.length) return;

  const placeholders = projectIds.map(() => "?").join(", ");
  const rows = await dbQuery(
    `SELECT project_id
     FROM \`${config.DB_TABLE_PROJECTS}\`
     WHERE organization_id = ? AND project_id IN (${placeholders})`,
    [organizationId, ...projectIds]
  );

  const resolved = new Set((rows as any[]).map((r) => Number(r.project_id)));
  const missing = projectIds.filter((id) => !resolved.has(id));
  if (missing.length) {
    throw new Error(`Project IDs do not belong to organization ${organizationId}: ${missing.join(", ")}`);
  }
};

// =============================
// API Key Generation & Hashing
// =============================

export function hashApiKey(key: string): string {
  return crypto
    .createHmac(HMAC_ALGORITHM, config.API_KEY_SECRET!)
    .update(key)
    .digest("hex");
}

// =============================
// Database Operations
// =============================

export async function initApiKeysTable(): Promise<void> {

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS \`${config.MARIADB_DATABASE}\`.\`${config.DB_TABLE_KEYS}\` (
      id VARCHAR(36) PRIMARY KEY,
      organization_id INT UNSIGNED NULL,
      hashed_key CHAR(64) NOT NULL UNIQUE,
      privilege_level INT NOT NULL DEFAULT ${config.privilege.user},
      valid_until BIGINT NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL,
      last_used BIGINT,
      status ENUM('active', 'disabled', 'expired') NOT NULL DEFAULT 'active',
      username VARCHAR(255) NOT NULL,
      FOREIGN KEY (organization_id) REFERENCES \`${config.DB_TABLE_ORGANIZATIONS}\`(organization_id) ON DELETE SET NULL,
      INDEX idx_keys_org_status (organization_id, status),
      INDEX idx_keys_org_username (organization_id, username),
      INDEX idx_keys_org_valid_until (organization_id, valid_until)
    )
  `);
}

export type IssueApiKeyOptions = {
  organizationId?: number | null;
  validUntilUnix?: number;
  providedKey?: string;
};

export async function issueApiKey(
  username: string,
  privilegeLevel: number,
  options: IssueApiKeyOptions = {}
): Promise<{ keyId: string; plainKey: string }> {
  const keyId = crypto.randomUUID();
  let prefix = "sk_user_";
  if (privilegeLevel >= config.privilege.superadmin) {
    prefix = "sk_superadmin_";
  } else if (privilegeLevel >= config.privilege.admin) {
    prefix = "sk_admin_";
  } else if (privilegeLevel >= config.privilege.projectadmin) {
    prefix = "sk_projectadmin_";
  } else if (privilegeLevel >= config.privilege.editor) {
    prefix = "sk_editor_";
  }

  const validUntilUnix = Number(options.validUntilUnix ?? 0);
  const organizationId = options.organizationId ?? null;
  const providedKey = options.providedKey;

  if (privilegeLevel < config.privilege.superadmin && !organizationId) {
    throw new Error("organization_id is required for non-superadmin keys.");
  }
  if (privilegeLevel >= config.privilege.superadmin && organizationId !== null) {
    throw new Error("superadmin keys must be global and cannot be bound to an organization.");
  }

  const trimmedProvidedKey = providedKey?.trim();
  const keyBody = crypto.randomBytes(32).toString("hex");
  const plainKey = trimmedProvidedKey && trimmedProvidedKey.length > 0
    ? trimmedProvidedKey
    : `${prefix}${keyBody}`;
  const hashedKey = hashApiKey(plainKey);
  const now = Math.floor(Date.now() / 1000);

  await dbQuery(
    `INSERT INTO \`${config.MARIADB_DATABASE}\`.\`${config.DB_TABLE_KEYS}\`
     (id, organization_id, hashed_key, privilege_level, valid_until, created_at, status, username)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`,
    [keyId, organizationId, hashedKey, privilegeLevel, validUntilUnix, now, username]
  );

  return { keyId, plainKey };
}

export async function validateApiKey(
  authHeader: string | undefined
): Promise<ApiKeyRecord | null> {
  if (!authHeader) return null;

  const match = authHeader.match(/^Bearer\s+(.+)$/);
  if (!match) return null;

  const providedKey = match[1];

  try {

    const records = await dbQuery(
      `SELECT * FROM \`${config.MARIADB_DATABASE}\`.\`${config.DB_TABLE_KEYS}\`
       WHERE hashed_key = ?`,
      [hashApiKey(providedKey)]
    );

    if (records.length === 0) return null;

    const record = records[0] as any;

    if (record.status !== "active") return null;

    const now = Math.floor(Date.now() / 1000);
    if (record.valid_until > 0 && record.valid_until < now) {
      await dbQuery(
        `UPDATE \`${config.MARIADB_DATABASE}\`.\`${config.DB_TABLE_KEYS}\`
         SET status = 'expired' WHERE id = ?`,
        [record.id]
      );
      return null;
    }

    await dbQuery(
      `UPDATE \`${config.MARIADB_DATABASE}\`.\`${config.DB_TABLE_KEYS}\`
       SET last_used = ? WHERE id = ?`,
      [now, record.id]
    );

    return {
      id: String(record.id),
      organization_id: toNumberOrNull(record.organization_id),
      hashed_key: String(record.hashed_key),
      privilege_level: Number(record.privilege_level),
      valid_until: Number(record.valid_until),
      created_at: Number(record.created_at),
      last_used: toNumberOrNull(record.last_used),
      status: record.status,
      username: String(record.username),
    };
  } catch (error) {
    console.error("Error validating API key:", error);
    return null;
  }
}

export function hasPrivilege(
  record: ApiKeyRecord,
  requiredLevel: number
): boolean {
  return record.privilege_level >= requiredLevel;
}

export async function getApiKeyMetadata(keyId: string): Promise<ApiKeyMetadata | null> {

  const records = await dbQuery(
    `SELECT id, organization_id, hashed_key, privilege_level, valid_until, created_at, last_used, status, username
     FROM \`${config.MARIADB_DATABASE}\`.\`${config.DB_TABLE_KEYS}\`
     WHERE id = ?`,
    [keyId]
  );

  if (records.length === 0) return null;

  const r = records[0] as any;
  const keyRecord: ApiKeyRecord = {
    id: String(r.id),
    organization_id: toNumberOrNull(r.organization_id),
    hashed_key: String(r.hashed_key),
    privilege_level: Number(r.privilege_level),
    valid_until: Number(r.valid_until),
    created_at: Number(r.created_at),
    last_used: toNumberOrNull(r.last_used),
    status: r.status,
    username: String(r.username),
  };

  return {
    id: r.id,
    key_prefix: r.hashed_key.substring(0, KEY_PREFIX_LENGTH),
    organization_id: toNumberOrNull(r.organization_id),
    username: r.username,
    privilege_level: r.privilege_level,
    status: r.status,
    valid_until: Number(r.valid_until),
    last_used: toNumberOrNull(r.last_used),
    created_at: Number(r.created_at),
    project_ids: await resolveAccessibleProjectIdsForKey(keyRecord),
  };
}

export async function resolveAccessibleProjectIdsForKey(record: ApiKeyRecord): Promise<number[]> {
  const orgId = Number(record.organization_id ?? 0);

  // Superadmin keys are global and can see all projects.
  if (hasPrivilege(record, config.privilege.superadmin) && record.organization_id == null) {
    const all = await dbQuery(`SELECT project_id FROM \`${config.DB_TABLE_PROJECTS}\` ORDER BY project_id ASC`);
    return (all as any[]).map((r) => Number(r.project_id)).filter((id) => Number.isInteger(id) && id > 0);
  }

  if (!Number.isInteger(orgId) || orgId <= 0) {
    return [];
  }

  // Admin keys in an organization implicitly see all projects in that organization.
  if (hasPrivilege(record, config.privilege.admin)) {
    const allOrg = await dbQuery(
      `SELECT project_id FROM \`${config.DB_TABLE_PROJECTS}\` WHERE organization_id = ? ORDER BY project_id ASC`,
      [orgId]
    );
    return (allOrg as any[]).map((r) => Number(r.project_id)).filter((id) => Number.isInteger(id) && id > 0);
  }

  // User/editor/projectadmin are scoped by explicit mapping entries.
  const mapped = await dbQuery(
    `SELECT ap.project_id
     FROM \`${config.DB_TABLE_API_KEY_PROJECTS}\` ap
     JOIN \`${config.DB_TABLE_PROJECTS}\` p ON p.project_id = ap.project_id
     WHERE ap.api_key_id = ? AND p.organization_id = ?
     ORDER BY ap.project_id ASC`,
    [record.id, orgId]
  );

  return (mapped as any[]).map((r) => Number(r.project_id)).filter((id) => Number.isInteger(id) && id > 0);
}

export async function listApiKeys(organizationId?: number | null): Promise<ApiKeyMetadata[]> {

  const whereClause = organizationId == null ? "" : "WHERE k.organization_id = ?";
  const records = await dbQuery(
    `SELECT
        k.id,
        k.organization_id,
        k.privilege_level,
        k.valid_until,
        k.created_at,
        k.last_used,
        k.status,
        k.username,
        k.hashed_key,
        o.slug AS organization_slug,
        o.name AS organization_name
     FROM \`${config.MARIADB_DATABASE}\`.\`${config.DB_TABLE_KEYS}\` k
     LEFT JOIN \`${config.DB_TABLE_ORGANIZATIONS}\` o ON k.organization_id = o.organization_id
     ${whereClause}
     ORDER BY k.created_at DESC`,
    organizationId == null ? [] : [organizationId]
  );

  const result: ApiKeyMetadata[] = [];
  for (const r of records as any[]) {
    const keyRecord: ApiKeyRecord = {
      id: String(r.id),
      organization_id: toNumberOrNull(r.organization_id),
      hashed_key: String(r.hashed_key),
      privilege_level: Number(r.privilege_level),
      valid_until: Number(r.valid_until),
      created_at: Number(r.created_at),
      last_used: toNumberOrNull(r.last_used),
      status: r.status,
      username: String(r.username),
    };

    result.push({
      id: r.id,
      organization_id: toNumberOrNull(r.organization_id),
      organization_slug: r.organization_slug ?? null,
      organization_name: r.organization_name ?? null,
      username: r.username,
      privilege_level: Number(r.privilege_level),
      status: r.status,
      valid_until: Number(r.valid_until),
      last_used: toNumberOrNull(r.last_used),
      created_at: Number(r.created_at),
      key_prefix: String(r.hashed_key || "").substring(0, KEY_PREFIX_LENGTH),
      project_ids: await resolveAccessibleProjectIdsForKey(keyRecord),
    });
  }
  return result;
}

export async function disableApiKey(keyId: string, organizationId?: number | null): Promise<boolean> {

  const scopedWhere = organizationId == null ? "id = ?" : "id = ? AND organization_id = ?";
  const result = await dbQuery(
    `UPDATE \`${config.MARIADB_DATABASE}\`.\`${config.DB_TABLE_KEYS}\`
     SET status = 'disabled' WHERE ${scopedWhere}`,
    organizationId == null ? [keyId] : [keyId, organizationId]
  );
  return (result as any).affectedRows > 0;
}

export async function enableApiKey(keyId: string, organizationId?: number | null): Promise<boolean> {

  const scopedWhere = organizationId == null ? "id = ?" : "id = ? AND organization_id = ?";
  const result = await dbQuery(
    `UPDATE \`${config.MARIADB_DATABASE}\`.\`${config.DB_TABLE_KEYS}\`
     SET status = 'active' WHERE ${scopedWhere}`,
    organizationId == null ? [keyId] : [keyId, organizationId]
  );
  return (result as any).affectedRows > 0;
}

export async function deleteApiKey(keyId: string, organizationId?: number | null): Promise<boolean> {

  const scopedWhere = organizationId == null ? "id = ?" : "id = ? AND organization_id = ?";
  const result = await dbQuery(
    `DELETE FROM \`${config.MARIADB_DATABASE}\`.\`${config.DB_TABLE_KEYS}\`
     WHERE ${scopedWhere}`,
    organizationId == null ? [keyId] : [keyId, organizationId]
  );
  return (result as any).affectedRows > 0;
}

export async function addOrganization(slug: string, name: string): Promise<OrganizationRecord> {
  const cleanSlug = String(slug || "").trim().toLowerCase();
  const cleanName = String(name || "").trim();

  if (!cleanSlug || !/^[a-z0-9][a-z0-9_-]{1,118}[a-z0-9]$/.test(cleanSlug)) {
    throw new Error("Invalid organization slug. Use 3-120 chars: a-z, 0-9, underscore, dash.");
  }
  if (!cleanName) {
    throw new Error("Organization name is required.");
  }

  const insertResult = await dbQuery(
    `INSERT INTO \`${config.DB_TABLE_ORGANIZATIONS}\` (slug, name) VALUES (?, ?)`,
    [cleanSlug, cleanName]
  );

  const orgId = Number((insertResult as any)?.insertId ?? 0);
  if (!Number.isInteger(orgId) || orgId <= 0) {
    throw new Error("Failed to create organization.");
  }

  return {
    organization_id: orgId,
    slug: cleanSlug,
    name: cleanName,
  };
}

export async function listOrganizations(): Promise<OrganizationRecord[]> {
  const records = await dbQuery(
    `SELECT organization_id, slug, name, created_at
     FROM \`${config.DB_TABLE_ORGANIZATIONS}\`
     ORDER BY name ASC, slug ASC`
  );

  return (records as any[]).map((r: any) => ({
    organization_id: Number(r.organization_id),
    slug: String(r.slug || ""),
    name: String(r.name || ""),
    created_at: r.created_at,
  }));
}

export async function deleteOrganization(organizationId: number): Promise<boolean> {
  const id = Number(organizationId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("organization_id must be a positive integer.");
  }

  const result = await dbQuery(
    `DELETE FROM \`${config.DB_TABLE_ORGANIZATIONS}\` WHERE organization_id = ?`,
    [id]
  );
  return (result as any).affectedRows > 0;
}

export async function addProject(organizationId: number, slug: string | undefined, name: string, description?: string | null): Promise<ProjectRecord> {
  const orgId = Number(organizationId);
  const cleanName = String(name || "").trim();
  const cleanDescription = description == null ? null : String(description).trim() || null;
  const proposedSlug = String(slug || "").trim().toLowerCase() || deriveSlugFromName(cleanName);

  if (!Number.isInteger(orgId) || orgId <= 0) {
    throw new Error("organization_id must be a positive integer.");
  }
  if (!cleanName) {
    throw new Error("Project name is required.");
  }
  if (!proposedSlug || !/^[a-z0-9][a-z0-9_-]{1,118}[a-z0-9]$/.test(proposedSlug)) {
    throw new Error("Invalid project slug. Use 3-120 chars: a-z, 0-9, underscore, dash.");
  }

  const result = await dbQuery(
    `INSERT INTO \`${config.DB_TABLE_PROJECTS}\` (organization_id, slug, name, description) VALUES (?, ?, ?, ?)`,
    [orgId, proposedSlug, cleanName, cleanDescription]
  );

  const projectId = Number((result as any)?.insertId ?? 0);
  if (!Number.isInteger(projectId) || projectId <= 0) {
    throw new Error("Failed to create project.");
  }

  return {
    project_id: projectId,
    organization_id: orgId,
    slug: proposedSlug,
    name: cleanName,
    description: cleanDescription,
    document_count: 0,
  };
}

export async function listProjects(organizationId?: number | null): Promise<ProjectRecord[]> {
  const whereClause = organizationId == null ? "" : "WHERE p.organization_id = ?";
  const records = await dbQuery(
    `SELECT p.project_id, p.organization_id, p.slug, p.name, p.description, p.created_at,
            COUNT(m.document_id) AS document_count
     FROM \`${config.DB_TABLE_PROJECTS}\` p
     LEFT JOIN \`${config.DB_TABLE_DOCUMENT_PROJECTS}\` m ON m.project_id = p.project_id
     ${whereClause}
     GROUP BY p.project_id, p.organization_id, p.slug, p.name, p.description, p.created_at
     ORDER BY p.name ASC, p.slug ASC`,
    organizationId == null ? [] : [organizationId]
  );

  return (records as any[]).map((r) => ({
    project_id: Number(r.project_id),
    organization_id: Number(r.organization_id),
    slug: String(r.slug || ""),
    name: String(r.name || ""),
    description: r.description == null ? null : String(r.description),
    document_count: Number(r.document_count ?? 0),
    created_at: r.created_at,
  }));
}

export async function updateProject(projectId: number, updates: { name?: string; description?: string | null }): Promise<ProjectRecord | null> {
  const id = Number(projectId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("project_id must be a positive integer.");
  }

  const nextName = updates.name == null ? null : String(updates.name).trim();
  const nextDescription = updates.description == null ? null : String(updates.description).trim() || null;

  const sets: string[] = [];
  const values: any[] = [];

  if (nextName !== null) {
    if (!nextName) {
      throw new Error("Project name is required.");
    }
    sets.push("name = ?");
    values.push(nextName);
  }

  if (updates.description !== undefined) {
    sets.push("description = ?");
    values.push(nextDescription);
  }

  if (!sets.length) {
    throw new Error("At least one field must be provided for update.");
  }

  await dbQuery(
    `UPDATE \`${config.DB_TABLE_PROJECTS}\` SET ${sets.join(", ")} WHERE project_id = ?`,
    [...values, id]
  );

  const rows = await dbQuery(
    `SELECT p.project_id, p.organization_id, p.slug, p.name, p.description, p.created_at,
            COUNT(m.document_id) AS document_count
     FROM \`${config.DB_TABLE_PROJECTS}\` p
     LEFT JOIN \`${config.DB_TABLE_DOCUMENT_PROJECTS}\` m ON m.project_id = p.project_id
     WHERE p.project_id = ?
     GROUP BY p.project_id, p.organization_id, p.slug, p.name, p.description, p.created_at
     LIMIT 1`,
    [id]
  );

  if (!Array.isArray(rows) || rows.length === 0) {
    return null;
  }

  const row = rows[0] as any;
  return {
    project_id: Number(row.project_id),
    organization_id: Number(row.organization_id),
    slug: String(row.slug || ""),
    name: String(row.name || ""),
    description: row.description == null ? null : String(row.description),
    document_count: Number(row.document_count ?? 0),
    created_at: row.created_at,
  };
}

export async function deleteProject(projectId: number): Promise<boolean> {
  const id = Number(projectId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("project_id must be a positive integer.");
  }

  const refs = await dbQuery(
    `SELECT COUNT(*) AS count FROM \`${config.DB_TABLE_DOCUMENT_PROJECTS}\` WHERE project_id = ?`,
    [id]
  );
  const count = Array.isArray(refs)
    ? Number((refs[0] as any)?.count ?? 0)
    : Number((refs as any)?.count ?? 0);

  if (count > 0) {
    throw new Error("Cannot delete project with existing documents.");
  }

  const result = await dbQuery(
    `DELETE FROM \`${config.DB_TABLE_PROJECTS}\` WHERE project_id = ?`,
    [id]
  );
  return (result as any).affectedRows > 0;
}

export async function replaceApiKeyProjectAccess(keyId: string, projectIdsRaw: unknown): Promise<number[]> {
  const projectIds = normalizeProjectIds(projectIdsRaw);

  const key = await resolveApiKeyById(keyId);
  if (!key) {
    throw new Error("API key not found.");
  }
  if (hasPrivilege(key, config.privilege.admin)) {
    // admin and superadmin are implicit all-access via app logic; mappings are not required.
    return [];
  }

  const orgId = Number(key.organization_id ?? 0);
  if (!Number.isInteger(orgId) || orgId <= 0) {
    throw new Error("Mapped keys must be organization-bound.");
  }

  if (!projectIds.length) {
    throw new Error("At least one project_id is required for non-admin keys.");
  }

  await assertProjectsBelongToOrganization(orgId, projectIds);

  await dbQuery(
    `DELETE FROM \`${config.DB_TABLE_API_KEY_PROJECTS}\` WHERE api_key_id = ?`,
    [keyId]
  );

  const placeholders = projectIds.map(() => "(?, ?)").join(", ");
  const values: any[] = [];
  for (const projectId of projectIds) {
    values.push(keyId, projectId);
  }

  await dbQuery(
    `INSERT INTO \`${config.DB_TABLE_API_KEY_PROJECTS}\` (api_key_id, project_id) VALUES ${placeholders}`,
    values
  );

  return projectIds;
}

export async function listApiKeyProjectAccess(keyId: string): Promise<ApiKeyProjectAccessRecord[]> {
  const rows = await dbQuery(
    `SELECT ap.api_key_id, ap.project_id, p.organization_id, p.slug AS project_slug, p.name AS project_name
     FROM \`${config.DB_TABLE_API_KEY_PROJECTS}\` ap
     JOIN \`${config.DB_TABLE_PROJECTS}\` p ON p.project_id = ap.project_id
     WHERE ap.api_key_id = ?
     ORDER BY ap.project_id ASC`,
    [keyId]
  );

  return (rows as any[]).map((r) => ({
    api_key_id: String(r.api_key_id),
    project_id: Number(r.project_id),
    organization_id: Number(r.organization_id),
    project_slug: String(r.project_slug || ""),
    project_name: String(r.project_name || ""),
  }));
}

export async function assertCallerCanAssignProjects(
  caller: ApiKeyRecord,
  targetOrganizationId: number,
  targetPrivilege: number,
  projectIdsRaw: unknown
): Promise<number[]> {
  const projectIds = normalizeProjectIds(projectIdsRaw);

  if (hasPrivilege(caller, config.privilege.superadmin) && caller.organization_id == null) {
    if (targetPrivilege < config.privilege.admin && !projectIds.length) {
      throw new Error("project_ids are required for non-admin keys.");
    }
    if (projectIds.length) {
      await assertProjectsBelongToOrganization(targetOrganizationId, projectIds);
    }
    return projectIds;
  }

  const callerOrgId = Number(caller.organization_id ?? 0);
  if (!Number.isInteger(callerOrgId) || callerOrgId <= 0) {
    throw new Error("Organization-bound key required.");
  }
  if (callerOrgId !== targetOrganizationId) {
    throw new Error("Cannot assign projects outside caller organization.");
  }

  if (hasPrivilege(caller, config.privilege.admin)) {
    if (targetPrivilege < config.privilege.admin && !projectIds.length) {
      throw new Error("project_ids are required for non-admin keys.");
    }
    if (projectIds.length) {
      await assertProjectsBelongToOrganization(callerOrgId, projectIds);
    }
    return projectIds;
  }

  if (!hasPrivilege(caller, config.privilege.projectadmin)) {
    throw new Error("Caller lacks privileges to issue project-scoped keys.");
  }

  if (!projectIds.length) {
    throw new Error("project_ids are required for projectadmin-issued keys.");
  }

  await assertProjectsBelongToOrganization(callerOrgId, projectIds);

  const callerProjects = new Set(await resolveAccessibleProjectIdsForKey(caller));
  for (const projectId of projectIds) {
    if (!callerProjects.has(projectId)) {
      throw new Error(`Caller cannot assign project ${projectId}.`);
    }
  }

  return projectIds;
}

