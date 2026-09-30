import type { PoolConnection } from "mariadb";
import { config } from "./config.js";

export class ProjectMembershipError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export function parseDocumentProjects(body: { project_ids?: unknown; project_id?: unknown }): number[] {
  const raw = body.project_ids ?? (body.project_id == null ? [] : [body.project_id]);
  if (!Array.isArray(raw) || !raw.length || raw.some(id => !Number.isInteger(Number(id)) || Number(id) <= 0)) {
    throw new ProjectMembershipError("Select at least one valid project");
  }
  return [...new Set(raw.map(Number))].sort((a, b) => a - b);
}

export async function getDocumentProjects(conn: PoolConnection, documentId: number): Promise<number[]> {
  const rows = await conn.query(`SELECT project_id FROM \`${config.DB_TABLE_DOCUMENT_PROJECTS}\` WHERE document_id = ? ORDER BY project_id`, [documentId]);
  return rows.map((row: any) => Number(row.project_id));
}

export async function validateDocumentProjects(conn: PoolConnection, organizationId: number, projectIds: number[]) {
  const rows = await conn.query(
    `SELECT project_id FROM \`${config.DB_TABLE_PROJECTS}\` WHERE organization_id = ? AND project_id IN (${projectIds.map(() => "?").join(",")}) LOCK IN SHARE MODE`,
    [organizationId, ...projectIds]
  );
  if (rows.length !== projectIds.length) throw new ProjectMembershipError("All projects must belong to the document's organization");
}

// Call within the document transaction. Keep project_id for legacy clients and
// the crawler's source project; all access/filtering uses the membership table.
export async function setDocumentProjects(conn: PoolConnection, documentId: number, organizationId: number, ids: number[]) {
  const projectIds = [...new Set(ids)].sort((a, b) => a - b);
  if (!projectIds.length) throw new ProjectMembershipError("Select at least one project");
  await validateDocumentProjects(conn, organizationId, projectIds);
  const docs = await conn.query(`SELECT project_id FROM \`${config.DB_TABLE_METADATA}\` WHERE document_id = ? FOR UPDATE`, [documentId]);
  const primaryId = Number(docs[0]?.project_id);
  const nextPrimaryId = projectIds.includes(primaryId) ? primaryId : projectIds[0];
  await conn.query(`UPDATE \`${config.DB_TABLE_METADATA}\` SET project_id = ? WHERE document_id = ?`, [nextPrimaryId, documentId]);
  await conn.query(`DELETE FROM \`${config.DB_TABLE_DOCUMENT_PROJECTS}\` WHERE document_id = ?`, [documentId]);
  await conn.query(`INSERT INTO \`${config.DB_TABLE_DOCUMENT_PROJECTS}\` (document_id, project_id) VALUES ${projectIds.map(() => "(?, ?)").join(",")}`, projectIds.flatMap(id => [documentId, id]));
}
