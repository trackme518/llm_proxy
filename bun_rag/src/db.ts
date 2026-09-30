import * as mariadb from "mariadb";
import type { PoolConnection } from "mariadb";
import pino from "pino";
import { config } from "./config.js";

const prettyLogs = config.LOG_PRETTY === "true";
const logger = pino(
  {
    level: config.LOG_LEVEL || "info",
    base: null,
    timestamp: false,
  },
  prettyLogs
    ? pino.transport({
        target: "pino-pretty",
        options: {
          colorize: true,
          ignore: "pid,hostname",
        },
      })
    : undefined
);

//===============================
// Database pool
//===============================
export const pool = mariadb.createPool({
  host: config.DB_HOST!,
  port: Number(config.DB_PORT),
  user: config.DB_USER!,
  password: config.MARIADB_APP_PASSWORD!,
  connectionLimit: 5,
});

//===============================
// Initialize DB and table
//===============================
export async function initDB(): Promise<void> {
  let conn: PoolConnection | undefined;
  try {
    conn = await pool.getConnection();

    const dbName = config.MARIADB_DATABASE;

    // Create database if not exists
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\``);

    // Use the database
    await conn.query(`USE \`${dbName}\``);

    const vectorDimRaw = config.DB_VECTOR_DIM;
    const vectorDim = Number(vectorDimRaw);
    if (!Number.isInteger(vectorDim) || vectorDim <= 0) {
      throw new Error(`DB_VECTOR_DIM must be a positive integer. Received: ${vectorDimRaw}`);
    }

    // Create organizations table first (tenant root entity)
    await conn.query(`
      CREATE TABLE IF NOT EXISTS \`${config.DB_TABLE_ORGANIZATIONS}\` (
        organization_id INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
        slug VARCHAR(120) NOT NULL,
        name VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_organization_slug (slug)
      )
    `);

    // Create projects table (organization -> many projects)
    await conn.query(`
      CREATE TABLE IF NOT EXISTS \`${config.DB_TABLE_PROJECTS}\` (
        project_id INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
        organization_id INT UNSIGNED NOT NULL,
        slug VARCHAR(120) NOT NULL,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (organization_id) REFERENCES \`${config.DB_TABLE_ORGANIZATIONS}\`(organization_id) ON DELETE RESTRICT,
        UNIQUE KEY uq_project_org_slug (organization_id, slug),
        INDEX idx_projects_org_name (organization_id, name)
      )
    `);

    try {
      await conn.query(`ALTER TABLE \`${config.DB_TABLE_PROJECTS}\` ADD COLUMN description TEXT NULL AFTER name`);
    } catch {}

    // Create documents metadata table if not exists
    await conn.query(`
      CREATE TABLE IF NOT EXISTS \`${config.DB_TABLE_METADATA}\` (
        document_id INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
        organization_id INT UNSIGNED NOT NULL,
        project_id INT UNSIGNED NOT NULL,
        title VARCHAR(500) NOT NULL,
        author VARCHAR(255),
        summary TEXT,
        content LONGTEXT,
        chunking_strategy VARCHAR(20),
        chunk_max_chars INT,
        chunk_overlap_chars INT,
        keywords JSON,
        domain VARCHAR(2000),
        date_published DATE,
        date_uploaded TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        language VARCHAR(50),
        content_hash CHAR(64),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (organization_id) REFERENCES \`${config.DB_TABLE_ORGANIZATIONS}\`(organization_id) ON DELETE RESTRICT,
        FOREIGN KEY (project_id) REFERENCES \`${config.DB_TABLE_PROJECTS}\`(project_id) ON DELETE RESTRICT,
        INDEX idx_metadata_org_project_uploaded (organization_id, project_id, date_uploaded),
        INDEX idx_metadata_project_domain (project_id, domain(255)),
        INDEX idx_metadata_project_language (project_id, language),
        INDEX idx_metadata_org_domain (organization_id, domain(255)),
        INDEX idx_metadata_org_language (organization_id, language),
        INDEX idx_metadata_org_uploaded (organization_id, date_uploaded),
        UNIQUE INDEX uq_org_project_content_hash (organization_id, project_id, content_hash)
      )
    `);

    // Ensure domain can store full canonical URLs and keep prefix indexes compatible.
    try {
      await conn.query(`ALTER TABLE \`${config.DB_TABLE_METADATA}\` DROP INDEX idx_metadata_project_domain`);
    } catch {}
    try {
      await conn.query(`ALTER TABLE \`${config.DB_TABLE_METADATA}\` DROP INDEX idx_metadata_org_domain`);
    } catch {}
    try {
      await conn.query(`ALTER TABLE \`${config.DB_TABLE_METADATA}\` MODIFY COLUMN domain VARCHAR(2000) NULL`);
    } catch (err) {
      logger.warn({ err }, "Failed to widen metadata.domain column");
    }
    try {
      await conn.query(`ALTER TABLE \`${config.DB_TABLE_METADATA}\` ADD INDEX idx_metadata_project_domain (project_id, domain(255))`);
    } catch {}
    try {
      await conn.query(`ALTER TABLE \`${config.DB_TABLE_METADATA}\` ADD INDEX idx_metadata_org_domain (organization_id, domain(255))`);
    } catch {}

    // Additive migration: preserve every existing document's project assignment.
    await conn.query(`
      CREATE TABLE IF NOT EXISTS \`${config.DB_TABLE_DOCUMENT_PROJECTS}\` (
        document_id INT UNSIGNED NOT NULL,
        project_id INT UNSIGNED NOT NULL,
        PRIMARY KEY (document_id, project_id),
        INDEX idx_document_projects_project (project_id, document_id),
        FOREIGN KEY (document_id) REFERENCES \`${config.DB_TABLE_METADATA}\`(document_id) ON DELETE CASCADE,
        FOREIGN KEY (project_id) REFERENCES \`${config.DB_TABLE_PROJECTS}\`(project_id) ON DELETE RESTRICT
      )
    `);
    await conn.query(`INSERT IGNORE INTO \`${config.DB_TABLE_DOCUMENT_PROJECTS}\` (document_id, project_id)
      SELECT document_id, project_id FROM \`${config.DB_TABLE_METADATA}\``);

    // Create chunks table if not exists
    await conn.query(`
      CREATE TABLE IF NOT EXISTS \`${config.DB_TABLE_CHUNKS}\` (
        id INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
        organization_id INT UNSIGNED NOT NULL,
        document_id INT UNSIGNED NOT NULL,
        chunk_id INT NOT NULL,
        chunk_start INT UNSIGNED NOT NULL,
        summary TEXT,
        content TEXT NOT NULL,
        embedding VECTOR(${vectorDim}) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (organization_id) REFERENCES \`${config.DB_TABLE_ORGANIZATIONS}\`(organization_id) ON DELETE RESTRICT,
        FOREIGN KEY (document_id) REFERENCES \`${config.DB_TABLE_METADATA}\`(document_id) ON DELETE CASCADE,
        UNIQUE KEY uq_org_document_chunk (organization_id, document_id, chunk_id),
        INDEX idx_chunks_org_document (organization_id, document_id),
        INDEX idx_chunks_org_created (organization_id, created_at),
        FULLTEXT INDEX (content),
        VECTOR INDEX (embedding) M=8 DISTANCE=cosine
      )
    `);

    // Create API keys table
    await conn.query(`
      CREATE TABLE IF NOT EXISTS \`${dbName}\`.\`${config.DB_TABLE_KEYS}\` (
        id VARCHAR(36) PRIMARY KEY,
        organization_id INT UNSIGNED NULL,
        hashed_key CHAR(64) NOT NULL UNIQUE,
        privilege_level INT NOT NULL DEFAULT 0,
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

    // Create key-project mapping table (many keys -> many projects)
    await conn.query(`
      CREATE TABLE IF NOT EXISTS \`${dbName}\`.\`${config.DB_TABLE_API_KEY_PROJECTS}\` (
        api_key_id VARCHAR(36) NOT NULL,
        project_id INT UNSIGNED NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (api_key_id, project_id),
        FOREIGN KEY (api_key_id) REFERENCES \`${dbName}\`.\`${config.DB_TABLE_KEYS}\`(id) ON DELETE CASCADE,
        FOREIGN KEY (project_id) REFERENCES \`${config.DB_TABLE_PROJECTS}\`(project_id) ON DELETE CASCADE,
        INDEX idx_key_projects_project (project_id),
        INDEX idx_key_projects_created (created_at)
      )
    `);

    const keyCountRows = await conn.query(
      `SELECT COUNT(*) AS count FROM \`${dbName}\`.\`${config.DB_TABLE_KEYS}\``
    );
    const keyCount = Array.isArray(keyCountRows)
      ? Number(keyCountRows[0]?.count ?? 0)
      : Number((keyCountRows as any)?.count ?? 0);

    if (keyCount === 0) {
      const superadminSecret = config.DEFAULT_SUPERADMIN_API_KEY?.trim();
      const defaultAdminSecret = config.DEFAULT_ADMIN_API_KEY?.trim();
      if (superadminSecret || defaultAdminSecret) {
        const defaultOrgSlug = config.DEFAULT_ORGANIZATION_SLUG.trim();
        const defaultOrgName = config.DEFAULT_ORGANIZATION_NAME.trim();
        const defaultProjectSlug = config.DEFAULT_PROJECT_SLUG.trim();
        const defaultProjectName = config.DEFAULT_PROJECT_NAME.trim();

        await conn.query(
          `INSERT IGNORE INTO \`${config.DB_TABLE_ORGANIZATIONS}\` (slug, name) VALUES (?, ?)`,
          [defaultOrgSlug, defaultOrgName]
        );

        const orgRows = await conn.query(
          `SELECT organization_id FROM \`${config.DB_TABLE_ORGANIZATIONS}\` WHERE slug = ? LIMIT 1`,
          [config.DEFAULT_ORGANIZATION_SLUG.trim()]
        );
        const defaultOrganizationId = Array.isArray(orgRows)
          ? Number(orgRows[0]?.organization_id)
          : Number((orgRows as any)?.organization_id);

        if (!Number.isInteger(defaultOrganizationId) || defaultOrganizationId <= 0) {
          throw new Error("Failed to resolve default organization for initial admin key issuance.");
        }

        await conn.query(
          `INSERT IGNORE INTO \`${config.DB_TABLE_PROJECTS}\` (organization_id, slug, name) VALUES (?, ?, ?)`,
          [defaultOrganizationId, defaultProjectSlug, defaultProjectName]
        );

        //avoid circular dependancy 
        const { issueApiKey } = await import("./auth.js");

        if (superadminSecret) {
          await issueApiKey("superadmin", config.privilege.superadmin, {
            validUntilUnix: 0,
            providedKey: superadminSecret,
          });
          logger.info("Initial superadmin API key issued from DEFAULT_SUPERADMIN_API_KEY");
        } else {
          logger.warn("DEFAULT_SUPERADMIN_API_KEY not set. Initial superadmin API key was not issued.");
        }

        if (defaultAdminSecret) {
          await issueApiKey("admin", config.privilege.admin, {
            organizationId: defaultOrganizationId,
            validUntilUnix: 0,
            providedKey: defaultAdminSecret,
          });
          logger.info({ organizationId: defaultOrganizationId }, "Initial admin API key issued from DEFAULT_ADMIN_API_KEY");
        } else {
          logger.warn("DEFAULT_ADMIN_API_KEY not set. Initial organization-bound admin API key was not issued.");
        }
      } else {
        logger.warn("DEFAULT_SUPERADMIN_API_KEY and DEFAULT_ADMIN_API_KEY not set. No initial API keys were issued.");
      }
    }

    logger.info("Database and tables ready with VECTOR, FULLTEXT, and API keys support");
  } catch (err) {
    logger.error({ err }, "DB initialization failed");
    throw err;
  } finally {
    if (conn) conn.release();
  }
}

//===============================
// Generic query function
//===============================
export async function query(sql: string, params?: any[]): Promise<any> {
  let conn: PoolConnection | undefined;
  try {
    conn = await pool.getConnection();
    await conn.query(`USE \`${config.MARIADB_DATABASE}\``);
    const res = await conn.query(sql, params);
    return res;
  } catch (err) {
    logger.error({ err }, "DB query failed");
    throw err;
  } finally {
    if (conn) conn.release();
  }
}

export async function withTransaction<T>(
  fn: (conn: PoolConnection) => Promise<T>
): Promise<T> {
  let conn: PoolConnection | undefined;
  try {
    conn = await pool.getConnection();
    await conn.query(`USE \`${config.MARIADB_DATABASE}\``);
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    if (conn) {
      try {
        await conn.rollback();
      } catch (rollbackError) {
        logger.error({ err: rollbackError }, "DB transaction rollback failed");
      }
    }
    throw err;
  } finally {
    if (conn) conn.release();
  }
}

//===============================
// Sanitize functions
//===============================
export function sanitizeString(value: any, maxLen?: number): string | null {
  if (value === undefined || value === null) return null;
  const str = String(value).trim();
  if (!str) return null;
  return maxLen ? str.slice(0, maxLen) : str;
}

export function sanitizeInt(value: any): number | null {
  if (value === undefined || value === null) return null;
  const num = Number(value);
  return Number.isInteger(num) ? num : null;
}

export function sanitizeDate(value: any): string | null {
  if (!value) return null;
  const date = new Date(value);
  return isNaN(date.getTime())
    ? null
    : date.toISOString().slice(0, 10); // YYYY-MM-DD
}
/*
export function sanitizeJSON(value: any): string | null {
  if (value === undefined || value === null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}
*/
function normalizeStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;

  const cleaned = value
    .map(v => String(v).trim())
    .filter(Boolean);

  return cleaned.length > 0 ? cleaned : null;
}

export function sanitizeKeywords(value: any): string[] | null {
  if (value === undefined || value === null || value === "") return null;

  if (Array.isArray(value)) {
    return normalizeStringArray(value);
  }

  if (typeof value === "string") {
    try {
      return normalizeStringArray(JSON.parse(value));
    } catch {
      return null;
    }
  }

  return null;
}
