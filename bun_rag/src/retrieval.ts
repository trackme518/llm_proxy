import { query } from "./db.js";
import { embedText } from "./embeddings.js";
import { config } from "./config.js";
//import { sentenceSplit } from "./chunking.js";

type RetrievalRow = {
  document_id: number;
  chunk_id: number;
  chunk_start: number;
  content: string;
  title?: string;
  author?: string;
  keywords?: string[];
  domain?: string;
  date_published?: string;
  language?: string;
  vector_distance?: number;
  keyword_score?: number;
};

type MergedRow = Omit<RetrievalRow, "vector_distance" | "keyword_score"> & {
  vector_score: number;
  keyword_score: number;
  has_vector_match: boolean;
  has_keyword_match: boolean;
};

const filterValidIds = (ids: number[] | undefined, min = 0): number[] =>
  Array.isArray(ids) ? ids.filter((id) => Number.isInteger(id) && id >= min) : [];

const buildWhere = (clauses: string[]): string =>
  clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

const buildScopedClauses = (globalScope: boolean, scopedProjectIds: number[], docIds: number[]) => {
  const orgFilterClause = globalScope ? "" : "dc.organization_id = ?";
  const projectFilterClause = scopedProjectIds.length
    ? `EXISTS (SELECT 1 FROM \`${config.DB_TABLE_DOCUMENT_PROJECTS}\` dp WHERE dp.document_id = dm.document_id AND dp.project_id IN (${scopedProjectIds.map(() => "?").join(",")}))`
    : (globalScope ? "" : "1 = 0");
  const docFilterClause = docIds.length
    ? `dc.document_id IN (${docIds.map(() => "?").join(",")})`
    : "";

  return { orgFilterClause, projectFilterClause, docFilterClause };
};

const buildQueryParams = (
  globalScope: boolean,
  organizationId: number | null,
  scopedProjectIds: number[],
  docIds: number[],
  leadingParam: string,
  topN: number,
  extraParam?: string
) => [
  leadingParam,
  ...(globalScope ? [] : [organizationId]),
  ...scopedProjectIds,
  ...docIds,
  ...(extraParam !== undefined ? [extraParam] : []),
  topN,
];

const runVectorQuery = async (
  vectorText: string,
  globalScope: boolean,
  organizationId: number | null,
  scopedProjectIds: number[],
  docIds: number[],
  topN: number,
  baseClauses: string[]
): Promise<RetrievalRow[]> => {
  const whereClause = buildWhere(baseClauses);
  const params = buildQueryParams(globalScope, organizationId, scopedProjectIds, docIds, vectorText, topN);

  return await query(
    `SELECT dc.document_id, dc.chunk_id, dc.chunk_start, dc.content, dm.title, dm.author, dm.keywords, dm.domain, dm.date_published, dm.language,
            VEC_DISTANCE_COSINE(dc.embedding, VEC_FromText(?)) as vector_distance
     FROM \`${config.DB_TABLE_CHUNKS}\` dc
     JOIN \`${config.DB_TABLE_METADATA}\` dm ON dc.document_id = dm.document_id AND dc.organization_id = dm.organization_id
     ${whereClause}
     ORDER BY vector_distance ASC
     LIMIT ?`,
    params
  );
};

const runKeywordQuery = async (
  queryText: string,
  globalScope: boolean,
  organizationId: number | null,
  scopedProjectIds: number[],
  docIds: number[],
  topN: number,
  baseClauses: string[]
): Promise<RetrievalRow[]> => {
  const whereClause = buildWhere([
    ...baseClauses,
    "MATCH(dc.content) AGAINST(? IN NATURAL LANGUAGE MODE)",
  ]);
  const params = buildQueryParams(globalScope, organizationId, scopedProjectIds, docIds, queryText, topN, queryText);

  return await query(
    `SELECT
        dc.document_id,
        dc.chunk_id,
        dc.chunk_start,
        dc.content,
        dm.title,
        dm.author,
        dm.keywords,
        dm.domain,
        dm.date_published,
        dm.language,
        MATCH(dc.content) AGAINST(? IN NATURAL LANGUAGE MODE) AS keyword_score
     FROM \`${config.DB_TABLE_CHUNKS}\` dc
     JOIN \`${config.DB_TABLE_METADATA}\` dm ON dc.document_id = dm.document_id AND dc.organization_id = dm.organization_id
     ${whereClause}
     ORDER BY keyword_score DESC
     LIMIT ?`,
    params
  );
};

const mergeHybridResults = (vectorResults: RetrievalRow[], keywordResults: RetrievalRow[]): MergedRow[] => {
  const resultMap = new Map<string, MergedRow>();

  const addResult = (r: RetrievalRow, type: "vector" | "keyword") => {
    const key = `${r.document_id}_${r.chunk_id}`;
    if (!resultMap.has(key)) {
      resultMap.set(key, {
        document_id: r.document_id,
        chunk_id: r.chunk_id,
        chunk_start: r.chunk_start,
        content: r.content,
        title: r.title,
        author: r.author,
        keywords: r.keywords,
        domain: r.domain,
        date_published: r.date_published,
        language: r.language,
        vector_score: 0,
        keyword_score: 0,
        has_vector_match: false,
        has_keyword_match: false,
      });
    }

    const entry = resultMap.get(key)!;
    if (type === "vector") {
      entry.vector_score = Math.max(0, 1 - Number(r.vector_distance ?? 1));
      entry.has_vector_match = true;
    } else {
      entry.keyword_score = Number(r.keyword_score ?? 0);
      entry.has_keyword_match = true;
    }
  };

  vectorResults.forEach((r) => addResult(r, "vector"));
  keywordResults.forEach((r) => addResult(r, "keyword"));

  return Array.from(resultMap.values());
};

const rankHybridResults = (
  rows: MergedRow[],
  vectorResults: RetrievalRow[],
  keywordResults: RetrievalRow[],
  topK: number
) => {
  const toKey = (documentId: number, chunkId: number) => `${documentId}_${chunkId}`;

  // RRF (Reciprocal Rank Fusion): combine ranked lists by summing reciprocal ranks.
  // This avoids score calibration issues across different retrievers (vector vs BM25).
  // A lower rank number means a better position in that retriever's list.
  const buildRankMap = (results: RetrievalRow[]) => {
    const rankMap = new Map<string, number>();
    results.forEach((r, index) => {
      const key = toKey(r.document_id, r.chunk_id);
      if (!rankMap.has(key)) {
        rankMap.set(key, index + 1);
      }
    });
    return rankMap;
  };

  const vectorRankMap = buildRankMap(vectorResults);
  const keywordRankMap = buildRankMap(keywordResults);

  // Standard RRF constant. Larger values flatten differences between nearby ranks.
  const RRF_K = 60;

  // Normalize BM25-like keyword score to [0, 1] for readability in API response.
  const maxKeywordScore = rows.length ? Math.max(...rows.map((r) => r.keyword_score), 0) : 0;

  const scoredRows = rows.map((r) => {
    const key = toKey(r.document_id, r.chunk_id);
    const vectorRank = vectorRankMap.get(key);
    const keywordRank = keywordRankMap.get(key);

    const vectorRrf = vectorRank ? 1 / (RRF_K + vectorRank) : 0;
    const keywordRrf = keywordRank ? 1 / (RRF_K + keywordRank) : 0;
    const hybridScore = vectorRrf + keywordRrf;

    const normalizedKeywordScore = maxKeywordScore > 0 ? r.keyword_score / maxKeywordScore : 0;

    return {
      ...r,
      keyword_score: normalizedKeywordScore,
      score: hybridScore,
    };
  });

  // Normalize final RRF score to [0, 1] using max score in this candidate set.
  const maxHybridScore = scoredRows.length ? Math.max(...scoredRows.map((r) => r.score), 0) : 0;

  return scoredRows
    .map((r) => ({
      ...r,
      score: maxHybridScore > 0 ? r.score / maxHybridScore : 0,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(({ has_vector_match, has_keyword_match, ...result }) => result);
};
/*
const toPaddedHex = (value: number, width: number): string =>
  Math.max(0, value).toString(16).toUpperCase().padStart(width, "0");

const injectCodes = <T extends { content: string; language?: string }>(rows: T[]): T[] => {
  return rows.map((row, chunkIndex) => {
    if (!row.content) {
      return row;
    }
    const language = typeof row.language === "string" && row.language.trim().length > 0
      ? row.language.trim()
      : "en";
    const sentences = sentenceSplit(row.content, false, language);

    if (sentences.length === 0) {
      return {
        ...row,
        content: `#${toPaddedHex(chunkIndex, 2)}-${toPaddedHex(0, 4)}# ${row.content}`,
      };
    }

    const chunkCode = toPaddedHex(chunkIndex, 2);
    const codedContent = sentences
      .map((sentence, sentenceIndex) => `#${chunkCode}-${toPaddedHex(sentenceIndex, 4)}# ${sentence.text.trim()}`)
      .join("\n");

    return {
      ...row,
      content: codedContent,
    };
  });
};
*/
export async function retrieve(
  queryText: string,
  organizationId: number | null,
  projectIds: number[],
  documentIds?: number[],
  topN = 25,
  topK = 5,
  globalScope = false
) {
  const qVector = (await embedText([queryText]))[0];
  const vectorText = JSON.stringify(qVector);

  const docIds = filterValidIds(documentIds);
  const scopedProjectIds = filterValidIds(projectIds, 1);
  const { orgFilterClause, projectFilterClause, docFilterClause } = buildScopedClauses(globalScope, scopedProjectIds, docIds);
  const baseClauses = [orgFilterClause, projectFilterClause, docFilterClause].filter(Boolean);

  const vectorResults = await runVectorQuery(
    vectorText,
    globalScope,
    organizationId,
    scopedProjectIds,
    docIds,
    topN,
    baseClauses
  );

  const keywordResults = await runKeywordQuery(
    queryText,
    globalScope,
    organizationId,
    scopedProjectIds,
    docIds,
    topN,
    baseClauses
  );

  const merged = mergeHybridResults(vectorResults, keywordResults);
  const ranked = rankHybridResults(merged, vectorResults, keywordResults, topK);
  return ranked; //injectCodes(ranked);
}

/*
//Using reranker model to refine results....higher overhead than BM25 hybrid approach (keyword + vector search, also reranking is more computationally expensive)
import { query } from "./db";
import { embedText } from "./embeddings";
import { rerank } from "./reranker";

export async function retrieve(queryText: string, topN = 30, topK = 5) {
  const qVector = await embedText(queryText);
  // MariaDB VEC_FromText expects JSON array format: "[0.1,0.2,0.3]"
  const vectorText = JSON.stringify(qVector);

  // Step 1: Vector search using cosine distance (lower = more similar)
  const rows = await query(
    `SELECT id, doc_id, chunk_id, content, embedding
     FROM documents
     ORDER BY VEC_DISTANCE_COSINE(embedding, VEC_FromText('${vectorText}')) ASC
     LIMIT ?`,
    [topN]
  );

  // Step 2: Rerank
  const passages = rows.map(r => r.content);
  const scores = await rerank(queryText, passages);

  // Combine rows with reranker scores (exclude database id)
  const combined = rows.map((r, i) => ({ 
    doc_id: r.doc_id,
    chunk_id: r.chunk_id,
    content: r.content,
    score: scores[i] 
  }));
  combined.sort((a, b) => b.score - a.score);

  return combined.slice(0, topK);
}
*/


/*
reranker.ts

import dotenv from "dotenv";
dotenv.config();
import axios from "axios";

const HF_RERANK_API = config.HF_RERANK_URL!;

export async function rerank(query: string, passages: string[]): Promise<number[]> {
  const res = await axios.post(HF_RERANK_API, { query, passages });
  return res.data as number[];
}

*/