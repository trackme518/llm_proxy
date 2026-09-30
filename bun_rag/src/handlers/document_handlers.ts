import { getDocumentProjects, setDocumentProjects, parseDocumentProjects, ProjectMembershipError } from "../document_projects.js";
import { prepareChunksAndEmbeddings, recalculateAllEmbeddings, recalculateDocumentEmbeddings } from "../embeddings.js";
import { query, sanitizeString, sanitizeInt, sanitizeDate, sanitizeKeywords, withTransaction } from "../db.js";
import { logger } from "../config.js";
import { jsonResponse } from "../http.js";
import { config } from "../config.js";
import { ApiKeyRecord, hasPrivilege, listProjects, resolveAccessibleProjectIdsForKey } from "../auth.js";
import crypto from "crypto";
import { TextChunk, ChunkingOptions, ChunkingStrategy } from "../chunking.js";

// =====================================
// Helper functions
// =====================================

type DocumentParams = {
  organizationId: number;
  projectId: number;
  projectIds: number[];
  title: string;
  author?: string | null;
  summary?: string | null;
  content: string;
  chunking_strategy?: ChunkingStrategy | null;
  chunk_max_chars?: number | null;
  chunk_overlap_chars?: number | null;
  keywords?: string[] | null;
  domain?: string | null;
  date_published?: string | null;
  language?: string | null;
  contentHash: string;
  chunks: TextChunk[];
  embeddings: number[][];
};

type IngestJobState = "processing" | "failed" | "finished";

type IngestJob = {
  progress: number;
  total: number;
  state: IngestJobState;
  expiresAt: number | null;
  duplicate?: boolean;
  documentId?: number | null;
};

const INGEST_JOB_RETENTION_MS = 60_000;
const ingestJobs = new Map<string, IngestJob>();

const cleanupExpiredIngestJobs = () => {
  const now = Date.now();
  for (const [jobId, job] of ingestJobs.entries()) {
    if (job.expiresAt !== null && job.expiresAt <= now) {
      ingestJobs.delete(jobId);
    }
  }
};

const setIngestJob = (jobId: string, next: Partial<IngestJob>) => {
  const current = ingestJobs.get(jobId);
  if (!current) return;
  ingestJobs.set(jobId, {
    ...current,
    ...next,
  });
};

const finishIngestJob = (jobId: string, state: Extract<IngestJobState, "failed" | "finished">) => {
  setIngestJob(jobId, {
    state,
    expiresAt: Date.now() + INGEST_JOB_RETENTION_MS,
  });
};

const createProcessingJob = () => {
  cleanupExpiredIngestJobs();
  const jobId = crypto.randomUUID();
  ingestJobs.set(jobId, {
    progress: 0,
    total: 0,
    state: "processing",
    expiresAt: null,
  });
  return jobId;
};

const processingJobResponse = (jobId: string) => {
  return jsonResponse({
    job_id: jobId,
    progress: 0,
    total: 0,
    state: "processing",
  });
};

const startTrackedIngestJob = (
  jobId: string,
  task: () => Promise<{ progress: number; total: number }>,
  errorMessage: string,
  errorContext: Record<string, unknown> = {}
) => {
  void (async () => {
    try {
      const result = await task();
      setIngestJob(jobId, { progress: result.progress, total: result.total });
      finishIngestJob(jobId, "finished");
    } catch (err) {
      finishIngestJob(jobId, "failed");
      logger.error({ err, jobId, ...errorContext }, errorMessage);
    }
  })();
};

// Insert into DB within transaction
async function ingestDocumentTransaction(params: DocumentParams) {
  return withTransaction(async (conn) => { //this is helper from db.ts
    const existing = await conn.query(
      `SELECT document_id FROM \`${config.DB_TABLE_METADATA}\` WHERE organization_id = ? AND project_id = ? AND content_hash = ? LIMIT 1 FOR UPDATE`,
      [params.organizationId, params.projectId, params.contentHash]
    );

    if (existing && existing.length > 0) {
      const id = Number(existing[0].document_id);
      await setDocumentProjects(conn, id, params.organizationId, [...await getDocumentProjects(conn, id), ...params.projectIds]);
      return { duplicate: true, documentId: id };
    }

    const keywordsJson = params.keywords ? JSON.stringify(params.keywords) : null;
    const docResult = await conn.query(
      `INSERT INTO \`${config.DB_TABLE_METADATA}\` (organization_id, project_id, title, author, summary, content, chunking_strategy, chunk_max_chars, chunk_overlap_chars, keywords, domain, date_published, language) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        params.organizationId,
        params.projectId,
        params.title,
        params.author || null,
        params.summary || null,
        params.content,
        params.chunking_strategy || null,
        params.chunk_max_chars ?? null,
        params.chunk_overlap_chars ?? null,
        keywordsJson,
        params.domain || null,
        params.date_published || null,
        params.language || null,
      ]
    );

    const documentId = Number(docResult.insertId);
    await setDocumentProjects(conn, documentId, params.organizationId, params.projectIds);

    await conn.query(
      `UPDATE \`${config.DB_TABLE_METADATA}\` SET content_hash = ? WHERE document_id = ?`,
      [params.contentHash, documentId]
    );

    const INSERT_BATCH_SIZE = 200;

    for (let i = 0; i < params.chunks.length; i += INSERT_BATCH_SIZE) {
      const batchEnd = Math.min(i + INSERT_BATCH_SIZE, params.chunks.length);
      const placeholders: string[] = [];
      const values: any[] = [];

      for (let j = i; j < batchEnd; j++) {
        placeholders.push("(?, ?, ?, ?, ?, VEC_FromText(?))");
        values.push(
          params.organizationId,
          documentId,
          j,
          params.chunks[j].start,
          params.chunks[j].text,
          JSON.stringify(params.embeddings[j])
        );
      }

      await conn.query(
        `INSERT INTO \`${config.DB_TABLE_CHUNKS}\` (organization_id, document_id, chunk_id, chunk_start, content, embedding)
         VALUES ${placeholders.join(", ")}`,
        values
      );
    }

    return { duplicate: false, documentId };
  });
}

const resolveProjectScope = async (auth: ApiKeyRecord): Promise<{ globalScope: boolean; organizationId: number | null; allowedProjectIds: number[] }> => {
  const globalScope = hasPrivilege(auth, config.privilege.superadmin) && auth.organization_id == null;
  const organizationId = auth.organization_id;
  if (globalScope) {
    return { globalScope, organizationId, allowedProjectIds: [] };
  }
  return {
    globalScope,
    organizationId,
    allowedProjectIds: await resolveAccessibleProjectIdsForKey(auth),
  };
};

async function documentProjectsInScope(documentId: number, allowed: number[]): Promise<boolean> {
  const rows = await query(`SELECT project_id FROM \`${config.DB_TABLE_DOCUMENT_PROJECTS}\` WHERE document_id = ?`, [documentId]);
  return rows.some((row: any) => allowed.includes(Number(row.project_id)));
}

// Text Chunking and Embedding Preparation
const computeContentHash = (content: string) => {
  return crypto
    .createHash("sha256")
    .update(content.trim())
    .digest("hex");
};


const normalizeChunkingOptions = (input: {
  chunking_strategy?: unknown;
  chunk_max_chars?: unknown;
  chunk_overlap_chars?: unknown;
  language?: unknown;
}): ChunkingOptions => {
  const strategy: ChunkingStrategy =
    input.chunking_strategy === "fixed" || input.chunking_strategy === "semantic"
      ? input.chunking_strategy
      : "semantic";

  const maxChars = Number.isFinite(Number(input.chunk_max_chars))
    ? Math.min(4096, Math.max(100, Math.floor(Number(input.chunk_max_chars))))
    : 1000;

  const maxOverlap = Math.floor(maxChars * 0.5);

  const defaultOverlap = Math.floor(maxChars * 0.25);

  const overlapChars = Number.isFinite(Number(input.chunk_overlap_chars))
    ? Math.max(0, Math.min(Math.floor(Number(input.chunk_overlap_chars)), maxOverlap))
    : Math.min(defaultOverlap, maxOverlap);

  const minChars = 0;
  const language = typeof input.language === "string" ? input.language.trim() || undefined : undefined;

  return { strategy, maxChars, overlapChars, minChars, language };
};


// =====================================
// REST API endpoints for documents
// =====================================

// Add New Document into DB
export async function ingestHandler(req: Request, ctx: { body: any; auth: ApiKeyRecord }): Promise<Response> {
  const auth = ctx?.auth as ApiKeyRecord | undefined;
  const scope = await resolveProjectScope(ctx.auth);
  const requestedOrgId = Number(ctx.body?.organization_id ?? 0);
  let requestedProjectIds: number[];
  try { requestedProjectIds = parseDocumentProjects(ctx.body ?? {}); }
  catch (error) { return jsonResponse({ error: String(error) }, 400); }
  const requestedProjectId = requestedProjectIds[0];

  let orgId = Number(auth?.organization_id ?? 0);
  if (scope.globalScope) {
    if (!Number.isInteger(requestedOrgId) || requestedOrgId <= 0) {
      return jsonResponse({ error: "organization_id is required for superadmin ingest" }, 400);
    }
    orgId = requestedOrgId;
  }

  if (!Number.isInteger(orgId) || orgId <= 0) {
    return jsonResponse({ error: "Organization-bound API key is required for ingest" }, 403);
  }

  if (!Number.isInteger(requestedProjectId) || requestedProjectId <= 0) {
    return jsonResponse({ error: "project_id is required for ingest" }, 400);
  }

  const orgProjects = await listProjects(orgId);
  const projectSet = new Set(orgProjects.map((p) => Number(p.project_id)));
  if (requestedProjectIds.some(id => !projectSet.has(id))) {
    return jsonResponse({ error: "All projects must belong to the selected organization" }, 400);
  }

  if (!scope.globalScope && requestedProjectIds.some(id => !scope.allowedProjectIds.includes(id))) {
    return jsonResponse({ error: "API key cannot ingest into this project" }, 403);
  }

  let { title, author, summary, content, keywords, domain, date_published, language,
    chunking_strategy, chunk_max_chars, chunk_overlap_chars } = ctx.body;
  title = sanitizeString(title);
  content = sanitizeString(content);
  const sanitizedLanguage = sanitizeString(language, 50);

  if (title == null || content == null) {
    return jsonResponse({ error: "title and text are required" }, 400);
  }

  const jobId = createProcessingJob();

  startTrackedIngestJob(
    jobId,
    async () => {
      logger.info({ title, jobId }, "Ingest started");

      const contentHash = computeContentHash(content);

      const chunkingOptions = normalizeChunkingOptions({
        chunking_strategy,
        chunk_max_chars,
        chunk_overlap_chars,
        language: sanitizedLanguage,
      });

      const { chunks, embeddings } = await prepareChunksAndEmbeddings(
        content,
        chunkingOptions,
        (processed, total) => {
          setIngestJob(jobId, { progress: processed, total });
        }
      );

      const sanitized = {
        title: title,
        author: sanitizeString(author, 255),
        summary: sanitizeString(summary),
        content: content,
        keywords: sanitizeKeywords(keywords),
        domain: sanitizeString(domain, 2000),
        date_published: sanitizeDate(date_published),
        language: sanitizedLanguage,
        chunking_strategy: chunkingOptions.strategy,
        chunk_max_chars: chunkingOptions.maxChars,
        chunk_overlap_chars: chunkingOptions.overlapChars,
        organizationId: orgId,
        projectId: requestedProjectId,
        projectIds: requestedProjectIds,
        contentHash: contentHash,
        chunks: chunks,
        embeddings: embeddings,
      };

      const tx = await ingestDocumentTransaction(sanitized);

      setIngestJob(jobId, { duplicate: tx.duplicate, documentId: tx.documentId });

      logger.info({ title, jobId, documentId: tx.documentId, chunks: chunks.length, duplicate: tx.duplicate }, "Ingest ended");

      return { progress: chunks.length, total: chunks.length };
    },
    "Ingest ended with error"
  );

  return processingJobResponse(jobId);
}

export async function ingestStatusHandler(req: Request, ctx: { url: URL }): Promise<Response> {
  cleanupExpiredIngestJobs();
  const jobId = (ctx.url.searchParams.get("job_id") || "").trim();

  if (!jobId) {
    return jsonResponse({ progress: 0, total: 0, state: "not found" });
  }

  const job = ingestJobs.get(jobId);
  if (!job) {
    return jsonResponse({ progress: 0, total: 0, state: "not found" });
  }

  return jsonResponse({
    progress: job.progress,
    total: job.total,
    state: job.state,
    duplicate: job.duplicate === true,
    document_id: job.documentId ?? null,
  });
}

//-----------------------------------------------------------------------------------------
// Force recalculate ALL emnedgins across ALL documents DANGER ZONE
export async function recalculateAllEmbeddingsHandler(req: Request, ctx: { auth: ApiKeyRecord }): Promise<Response> {
  try {
    const scope = await resolveProjectScope(ctx.auth);
    const jobId = createProcessingJob();

    startTrackedIngestJob(
      jobId,
      async () => {
        const result = await recalculateAllEmbeddings(
          scope.organizationId,
          scope.allowedProjectIds,
          scope.globalScope,
          (processed, total) => {
            setIngestJob(jobId, { progress: processed, total });
          }
        );

        return { progress: result.updated + result.failed, total: result.total };
      },
      "Recalculate all embeddings job failed"
    );

    return processingJobResponse(jobId);
  } catch (error) {
    logger.error({ err: error }, "Recalculate all embeddings error");
    return jsonResponse({ error: `Failed to recalculate all embeddings: ${error}` }, 500);
  }
}

//-----------------------------------------------------------------------------------------
// Update Content of Existing Document - Froces recalculating Embeddings automatically
export async function updateContentHandler(req: Request,ctx: { body: any; auth: ApiKeyRecord }): Promise<Response> {
  const raw = ctx.body ?? {};
  const document_id = sanitizeInt(raw.document_id);
  const content = sanitizeString(raw.content);

  if (!document_id || !content) {
    return jsonResponse({ error: "document_id and content are required" }, 400);
  }

  const contentHash = computeContentHash(content);
  const scope = await resolveProjectScope(ctx.auth);
  const globalScope = scope.globalScope;
  const orgId = scope.organizationId;

  if (!globalScope && (!orgId || orgId <= 0)) {
    return jsonResponse({ error: "Organization-bound API key is required" }, 403);
  }

  try {
    const result = await withTransaction(async (conn) => {
      const existing = globalScope
        ? await conn.query<any[]>(
          `SELECT document_id, organization_id, project_id FROM \`${config.DB_TABLE_METADATA}\` WHERE document_id = ? FOR UPDATE`,
          [document_id]
        )
        : await conn.query<any[]>(
          `SELECT document_id, organization_id, project_id FROM \`${config.DB_TABLE_METADATA}\` WHERE organization_id = ? AND document_id = ? FOR UPDATE`,
          [orgId, document_id]
        );

      if (!existing.length) {
        return { notFound: true };
      }

      const effectiveOrgId = Number(existing[0].organization_id);
      const effectiveProjectId = Number(existing[0].project_id);

      if (!globalScope && !(await getDocumentProjects(conn, document_id)).some(id => scope.allowedProjectIds.includes(id))) {
        return { forbidden: true };
      }

      const duplicate = await conn.query<any[]>(
        `SELECT document_id FROM \`${config.DB_TABLE_METADATA}\` WHERE organization_id = ? AND project_id = ? AND content_hash = ? AND document_id <> ? LIMIT 1`,
        [effectiveOrgId, effectiveProjectId, contentHash, document_id]
      );

      if (duplicate.length) {
        return { duplicate: true, duplicateId: duplicate[0].document_id };
      }

      await conn.query(
        `UPDATE \`${config.DB_TABLE_METADATA}\` SET content = ?, content_hash = ? WHERE organization_id = ? AND project_id = ? AND document_id = ?`,
        [content, contentHash, effectiveOrgId, effectiveProjectId, document_id]
      );

      return { updated: true, organizationId: effectiveOrgId, projectId: effectiveProjectId };
    });

    if ("notFound" in result && result.notFound) {
      return jsonResponse({ error: "Document not found" }, 404);
    }

    if ("duplicate" in result && result.duplicate) {
      return jsonResponse(
        { error: "Document content already exists", document_id: result.duplicateId },
        409
      );
    }

    if ("forbidden" in result && result.forbidden) {
      return jsonResponse({ error: "Document is outside your project scope" }, 403);
    }

    const resultOrgId = ("organizationId" in result && typeof result.organizationId === "number")
      ? result.organizationId
      : null;
    if (!resultOrgId) {
      return jsonResponse({ error: "Failed to resolve document organization" }, 500);
    }

    const embedResult = await recalculateDocumentEmbeddings(document_id, resultOrgId, false);

    return jsonResponse({
      success: true,
      document_id,
      chunks: embedResult.chunks,
    });
  } catch (error) {
    logger.error({ err: error }, "Update content error");
    return jsonResponse({ error: `Failed to update content: ${error}` }, 500);
  }
}

//-----------------------------------------------------------------------------------------
// Forces recalculating Embeddings for given document id
export async function recalculateEmbeddingsHandler(req: Request,ctx: { body: any; auth: ApiKeyRecord }): Promise<Response> {
  const raw = ctx.body ?? {};
  const document_id = sanitizeInt(raw.document_id);
  if (document_id == null) {
    return jsonResponse({ error: "document_id required." }, 400);
  }

  try {
    const scope = await resolveProjectScope(ctx.auth);
    const globalScope = scope.globalScope;
    if (!globalScope && (!scope.organizationId || scope.organizationId <= 0)) {
      return jsonResponse({ error: "Organization-bound API key is required" }, 403);
    }

    if (!globalScope) {
      const doc = await query(
        `SELECT project_id FROM \`${config.DB_TABLE_METADATA}\` WHERE organization_id = ? AND document_id = ? LIMIT 1`,
        [scope.organizationId, document_id]
      );
      if (!doc || !doc.length) {
        return jsonResponse({ error: "Document not found" }, 404);
      }
      if (!(await documentProjectsInScope(document_id, scope.allowedProjectIds))) {
        return jsonResponse({ error: "Document is outside your project scope" }, 403);
      }
    }

    const jobId = createProcessingJob();

    startTrackedIngestJob(
      jobId,
      async () => {
        const embedResult = await recalculateDocumentEmbeddings(
          document_id,
          scope.organizationId,
          globalScope,
          (processed, total) => {
            setIngestJob(jobId, { progress: processed, total });
          }
        );

        return { progress: embedResult.chunks, total: embedResult.chunks };
      },
      "Recalculate embeddings job failed",
      { document_id }
    );

    return processingJobResponse(jobId);
  } catch (error) {
    logger.error({ err: error }, "Recalculate embeddings error");
    return jsonResponse({ error: `Failed to recalculate embeddings: ${error}` }, 500);
  }
}

//------------------------------------------------------------------------------------------------
// Update Meta Data of Esiting Document, does NOT recalculate embeddings, just UPDATE IF changed
export async function updateMetadataHandler(req: Request, ctx: { body: any; auth: ApiKeyRecord }): Promise<Response> {
  const scope = await resolveProjectScope(ctx.auth);
  const raw = ctx.body ?? {};
  const documentId = sanitizeInt(raw.document_id);
  if (!documentId) return jsonResponse({ error: "document_id is required" }, 400);
  try {
    const result = await withTransaction(async conn => {
      const docs = await conn.query(`SELECT organization_id FROM \`${config.DB_TABLE_METADATA}\` WHERE document_id = ? FOR UPDATE`, [documentId]);
      if (!docs.length) throw new ProjectMembershipError("Document not found", 404);
      const organizationId = Number(docs[0].organization_id);
      const current = await getDocumentProjects(conn, documentId);
      if (!scope.globalScope && (scope.organizationId !== organizationId || !current.some(id => scope.allowedProjectIds.includes(id)))) {
        throw new ProjectMembershipError("Document is outside your project scope", 403);
      }
      let projectIds = current;
      if (raw.project_ids !== undefined) {
        const requested = parseDocumentProjects(raw);
        if (!scope.globalScope && requested.some(id => !scope.allowedProjectIds.includes(id) && !current.includes(id))) {
          throw new ProjectMembershipError("Cannot assign projects outside your scope", 403);
        }
        // A scoped editor can change visible memberships, never remove hidden ones.
        projectIds = [...new Set([...requested, ...current.filter(id => !scope.globalScope && !scope.allowedProjectIds.includes(id))])];
        await setDocumentProjects(conn, documentId, organizationId, projectIds);
      }
      const keywords = sanitizeKeywords(raw.keywords);
      const sanitized: Record<string, any> = {
        title: sanitizeString(raw.title, 500), author: sanitizeString(raw.author, 255),
        summary: sanitizeString(raw.summary), content: sanitizeString(raw.content),
        chunking_strategy: sanitizeString(raw.chunking_strategy, 20),
        chunk_max_chars: sanitizeInt(raw.chunk_max_chars), chunk_overlap_chars: sanitizeInt(raw.chunk_overlap_chars),
        keywords: keywords ? JSON.stringify(keywords) : null,
        domain: sanitizeString(raw.domain, 2000), date_published: sanitizeDate(raw.date_published),
        language: sanitizeString(raw.language, 50), content_hash: sanitizeString(raw.content_hash, 64),
      };
      const fields = Object.keys(sanitized).filter(key => sanitized[key] != null);
      if (fields.length) {
        await conn.query(`UPDATE \`${config.DB_TABLE_METADATA}\` SET ${fields.map(key => `\`${key}\` = ?`).join(", ")} WHERE document_id = ?`, [...fields.map(key => sanitized[key]), documentId]);
      }
      return { success: true, project_ids: projectIds, fields: [...fields, ...(raw.project_ids === undefined ? [] : ["project_ids"])] };
    });
    return jsonResponse(result);
  } catch (error) {
    if (error instanceof ProjectMembershipError) return jsonResponse({ error: error.message }, error.status);
    if ((error as any)?.code === "ER_DUP_ENTRY") return jsonResponse({ error: "This project already contains a document with the same content" }, 409);
    logger.error({ err: error }, "Update metadata error");
    return jsonResponse({ error: "Failed to update document metadata" }, 500);
  }
}

export async function deleteDocumentHandler(req: Request, ctx: { body: any; auth: ApiKeyRecord }): Promise<Response> {
    try {
      const { document_id } = ctx.body as any;
      const documentId = Number(document_id);
      if (!Number.isFinite(documentId) || documentId <= 0) {
        return jsonResponse({ error: "document_id must be a positive number" }, 400);
      }

      const scope = await resolveProjectScope(ctx.auth);
      const globalScope = scope.globalScope;
      const orgId = scope.organizationId;
      if (!globalScope && (!orgId || orgId <= 0)) {
        return jsonResponse({ error: "Organization-bound API key is required" }, 403);
      }

      if (!globalScope) {
        const doc = await query(
          `SELECT project_id FROM \`${config.DB_TABLE_METADATA}\` WHERE organization_id = ? AND document_id = ? LIMIT 1`,
          [orgId, documentId]
        );
        if (!doc || !doc.length) {
          return jsonResponse({ error: "Document not found" }, 404);
        }
        if (!(await documentProjectsInScope(documentId, scope.allowedProjectIds))) {
          return jsonResponse({ error: "Document is outside your project scope" }, 403);
        }
      }

      const result = await query(
        `DELETE FROM \`${config.DB_TABLE_METADATA}\` WHERE ${globalScope ? "document_id = ?" : "organization_id = ? AND document_id = ?"}`,
        globalScope ? [documentId] : [orgId, documentId]
      );

      const affected = result?.affectedRows ?? 0;
      if (!affected) {
        return jsonResponse({ error: "Document not found" }, 404);
      }

      return jsonResponse({ success: true, document_id: documentId, deleted: true });
    } catch (error) {
      logger.error({ err: error }, "Delete document error");
      return jsonResponse({ error: `Failed to delete document: ${error}` }, 500);
    }
}


