import { createEmbeddingClient } from "./embedding_client.js";
import { pool, query as dbQuery } from "./db.js";
import { chunkText, ChunkingOptions, ChunkingStrategy, TextChunk } from "./chunking.js";
import { config } from "./config.js";

async function fetchJson<T>(url: string, init: RequestInit = {}, timeoutMs = config.REQUEST_TIMEOUT): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status} ${response.statusText}${errorText ? `: ${errorText}` : ""}`);
    }

    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

// Shared by ingestion, recalculation and retrieval.
export const embedText = createEmbeddingClient({
  url: config.EMBEDDINGS_URL,
  model: config.EMBEDDINGS_MODEL,
  apiKey: config.EMBEDDINGS_API_KEY,
  timeoutMs: config.REQUEST_TIMEOUT,
  dimensions: Number(config.DB_VECTOR_DIM) || undefined,
});

const clampMaxChars = (value: any): number | undefined => {
  if (value === null || value === undefined || value === "") return undefined;
  const num = Number(value);
  if (!Number.isFinite(num)) return undefined;
  return Math.min(4096, Math.max(100, Math.floor(num)));
};

const clampOverlapChars = (value: any, maxChars: number): number | undefined => {
  if (value === null || value === undefined || value === "") return undefined;
  const num = Number(value);
  if (!Number.isFinite(num)) return undefined;
  const maxAllowed = Math.floor(maxChars * 0.5);
  return Math.max(0, Math.min(Math.floor(num), maxAllowed));
};

export type EmbeddingProgressCallback = (processed: number, total: number) => void;

export const prepareChunksAndEmbeddings = async (
  content: string,
  options: ChunkingOptions,
  onProgress?: EmbeddingProgressCallback
): Promise<{ chunks: TextChunk[]; embeddings: number[][] }> => {
  const chunks = await chunkText(content, options);

  const batchThreshold = config.EMBEDDING_BATCH_THRESHOLD;
  const embeddings: number[][] = [];
  let processed = 0;

  onProgress?.(processed, chunks.length);

  for (let i = 0; i < chunks.length; i += batchThreshold) {
    const batch = chunks.slice(i, i + batchThreshold).map((c) => c.text);
    const batchEmbeddings = await embedText(batch);
    embeddings.push(...batchEmbeddings);
    processed += batch.length;
    onProgress?.(processed, chunks.length);
  }

  return { chunks, embeddings };
};

export async function calculateDocumentEmbeddings(
  documentId: number,
  organizationId: number | null,
  globalScope: boolean,
  options: {
    chunking_strategy?: ChunkingStrategy | null;
    chunk_max_chars?: number | null;
    chunk_overlap_chars?: number | null;
    language?: string | null;
  },
  onProgress?: EmbeddingProgressCallback
): Promise<{ documentId: number; chunks: number }> {
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.query(`USE \`${config.MARIADB_DATABASE}\``);

    const rows = globalScope
      ? await conn.query(
        `SELECT content, chunking_strategy, chunk_max_chars, chunk_overlap_chars, language, organization_id FROM \`${config.DB_TABLE_METADATA}\` WHERE document_id = ? LIMIT 1`,
        [documentId]
      )
      : await conn.query(
        `SELECT content, chunking_strategy, chunk_max_chars, chunk_overlap_chars, language, organization_id FROM \`${config.DB_TABLE_METADATA}\` WHERE organization_id = ? AND document_id = ? LIMIT 1`,
        [organizationId, documentId]
      );

    if (!rows || rows.length === 0) {
      throw new Error("Document not found");
    }

    const row = rows[0];
    const effectiveOrgId = Number(row.organization_id);
    const content = row.content ?? "";
    if (!content) {
      throw new Error("Document content is empty");
    }

    const strategy: ChunkingStrategy =
      options.chunking_strategy === "fixed" || options.chunking_strategy === "semantic"
        ? options.chunking_strategy
        : "semantic";

    const parsedMaxChars = clampMaxChars(options.chunk_max_chars);
    const effectiveMaxChars = parsedMaxChars ?? config.DEFAULT_MAX_CHARS;
    const parsedOverlapChars = clampOverlapChars(options.chunk_overlap_chars, effectiveMaxChars);
    const effectiveOverlapChars = parsedOverlapChars ?? Math.floor(effectiveMaxChars * 0.25);
    const effectiveLanguage = options.language ?? row.language ?? null;

    const { chunks, embeddings } = await prepareChunksAndEmbeddings(
      content,
      {
        strategy,
        maxChars: effectiveMaxChars,
        overlapChars: effectiveOverlapChars,
        minChars: 0,
        language: effectiveLanguage ?? undefined,
      },
      onProgress
    );

    await conn.beginTransaction();

    await conn.query(
      `DELETE FROM \`${config.DB_TABLE_CHUNKS}\` WHERE organization_id = ? AND document_id = ?`,
      [effectiveOrgId, documentId]
    );

    const INSERT_BATCH_SIZE = 200;
    for (let i = 0; i < chunks.length; i += INSERT_BATCH_SIZE) {
      const batchEnd = Math.min(i + INSERT_BATCH_SIZE, chunks.length);
      const placeholders: string[] = [];
      const values: any[] = [];

      for (let j = i; j < batchEnd; j++) {
        placeholders.push("(?, ?, ?, ?, ?, VEC_FromText(?))");
        values.push(
          effectiveOrgId,
          documentId,
          j,
          chunks[j].start,
          chunks[j].text,
          JSON.stringify(embeddings[j])
        );
      }

      await conn.query(
        `INSERT INTO \`${config.DB_TABLE_CHUNKS}\` (organization_id, document_id, chunk_id, chunk_start, content, embedding)
         VALUES ${placeholders.join(", ")}`,
        values
      );
    }

    const existingStrategy = row.chunking_strategy ?? null;
    const existingMaxChars = row.chunk_max_chars ?? null;
    const existingOverlapChars = row.chunk_overlap_chars ?? null;
    if (
      existingStrategy !== strategy ||
      existingMaxChars !== (parsedMaxChars ?? null) ||
      existingOverlapChars !== (parsedOverlapChars ?? null)
    ) {
      await conn.query(
        `UPDATE \`${config.DB_TABLE_METADATA}\` SET chunking_strategy = ?, chunk_max_chars = ?, chunk_overlap_chars = ? WHERE organization_id = ? AND document_id = ?`,
        [strategy, parsedMaxChars ?? null, parsedOverlapChars ?? null, effectiveOrgId, documentId]
      );
    }

    await conn.commit();
    return { documentId, chunks: chunks.length };
  } catch (err) {
    if (conn) {
      try {
        await conn.rollback();
      } catch {
        // ignore rollback errors
      }
    }
    throw err;
  } finally {
    if (conn) conn.release();
  }
}

export async function recalculateDocumentEmbeddings(
  documentId: number,
  organizationId: number | null,
  globalScope: boolean,
  onProgress?: EmbeddingProgressCallback
): Promise<{ documentId: number; chunks: number }> {
  const rows = globalScope
    ? await dbQuery(
      `SELECT chunking_strategy, chunk_max_chars, chunk_overlap_chars, language FROM \`${config.DB_TABLE_METADATA}\` WHERE document_id = ? LIMIT 1`,
      [documentId]
    )
    : await dbQuery(
      `SELECT chunking_strategy, chunk_max_chars, chunk_overlap_chars, language FROM \`${config.DB_TABLE_METADATA}\` WHERE organization_id = ? AND document_id = ? LIMIT 1`,
      [organizationId, documentId]
    );

  if (!rows || rows.length === 0) {
    throw new Error("Document not found");
  }

  const row = rows[0];
  return calculateDocumentEmbeddings(
    documentId,
    organizationId,
    globalScope,
    {
      chunking_strategy: row.chunking_strategy ?? null,
      chunk_max_chars: row.chunk_max_chars ?? null,
      chunk_overlap_chars: row.chunk_overlap_chars ?? null,
      language: row.language ?? null,
    },
    onProgress
  );
}

export async function recalculateAllEmbeddings(
  organizationId: number | null,
  projectIds: number[],
  globalScope: boolean,
  onProgress?: EmbeddingProgressCallback
): Promise<{
  updated: number;
  failed: number;
  failures: { documentId: number; error: string }[];
  total: number;
}> {
  if (!config.DB_TABLE_METADATA) {
    throw new Error("DB_TABLE_METADATA must be set");
  }

  const validProjectIds = Array.isArray(projectIds)
    ? projectIds.filter((id) => Number.isInteger(id) && id > 0)
    : [];

  const rows = globalScope
    ? await dbQuery(`SELECT document_id FROM \`${config.DB_TABLE_METADATA}\` ORDER BY document_id ASC`)
    : validProjectIds.length
      ? await dbQuery(
        `SELECT m.document_id FROM \`${config.DB_TABLE_METADATA}\` m
         WHERE m.organization_id = ? AND EXISTS (SELECT 1 FROM \`${config.DB_TABLE_DOCUMENT_PROJECTS}\` dp WHERE dp.document_id = m.document_id AND dp.project_id IN (${validProjectIds.map(() => "?").join(",")}))
         ORDER BY document_id ASC`,
        [organizationId, ...validProjectIds]
      )
      : [];
  const failures: { documentId: number; error: string }[] = [];
  let updated = 0;

  const documents = (rows || [])
    .map((row: any) => Number(row.document_id))
    .filter((id: number) => Number.isFinite(id));

  const total = documents.length;
  let processed = 0;
  onProgress?.(processed, total);

  for (const documentId of documents) {
    try {
      await recalculateDocumentEmbeddings(documentId, organizationId, globalScope);
      updated += 1;
    } catch (err: any) {
      failures.push({ documentId, error: err?.message || String(err) });
    } finally {
      processed += 1;
      onProgress?.(processed, total);
    }
  }

  return { updated, failed: failures.length, failures, total };
}

//monitor embedding service health - separate service running in Python FastAPI
export async function checkEmbeddingServiceHealth() {
  const data = await fetchJson<any>(config.EMBEDDINGS_METRICS_URL, { method: "GET" }, 5000);
  console.log(`Active requests: ${data.active_requests}, CPU: ${data.cpu_percent}%`);
  return data;
}
