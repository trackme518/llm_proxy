import { query as dbQuery } from "./db.js";
import { retrieve } from "./retrieval.js";
import { config } from "./config.js";

export interface SearchResult {
  document_id: number;
  chunk_id: number;
  chunk_start: number;
  content?: string;
  language?: string;
  title: string;
  author?: string;
  keywords?: string[];
  domain?: string;
  date_published?: string;
  score: number;
}

export interface SearchResponse {
  citations: SearchResult[];
  error?: string;
  status?: number;
}

export const fetchProjects = async (organizationId: number | null, projectIds: number[], globalScope = false) => {
  const params: any[] = [];
  const whereParts: string[] = [];

  if (!globalScope) {
    whereParts.push("p.organization_id = ?");
    params.push(organizationId);
  }

  if (projectIds.length > 0) {
    whereParts.push(`p.project_id IN (${projectIds.map(() => "?").join(",")})`);
    params.push(...projectIds);
  } else if (!globalScope) {
    whereParts.push("1 = 0");
  }

  const whereClause = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";
  const projects = await dbQuery(
    `
    SELECT p.project_id, p.organization_id, p.slug, p.name, p.description,
           COUNT(m.document_id) AS document_count
    FROM \`${config.DB_TABLE_PROJECTS}\` p
    LEFT JOIN \`${config.DB_TABLE_DOCUMENT_PROJECTS}\` m ON m.project_id = p.project_id
    ${whereClause}
    GROUP BY p.project_id, p.organization_id, p.slug, p.name, p.description
    ORDER BY p.name ASC, p.slug ASC
  `,
    params
  );

  return (projects as any[]).map((p) => ({
    project_id: Number(p.project_id),
    organization_id: Number(p.organization_id),
    slug: String(p.slug || ""),
    title: String(p.name || ""),
    description: p.description == null ? null : String(p.description),
    document_count: Number(p.document_count ?? 0),
  }));
};

export const fetchDocuments = async (organizationId: number | null, projectIds: number[], globalScope = false) => {
  const params: any[] = [];
  const whereParts: string[] = [];

  if (!globalScope) {
    whereParts.push("m.organization_id = ?");
    params.push(organizationId);
  }

  if (projectIds.length > 0) {
    whereParts.push(`EXISTS (SELECT 1 FROM \`${config.DB_TABLE_DOCUMENT_PROJECTS}\` dp WHERE dp.document_id = m.document_id AND dp.project_id IN (${projectIds.map(() => "?").join(",")}))`);
    params.push(...projectIds);
  } else if (!globalScope) {
    whereParts.push("1 = 0");
  }

  const whereClause = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";
  const docs = await dbQuery(
    `
    SELECT m.document_id, m.organization_id, m.project_id, m.title, m.author, m.summary, m.content, m.chunking_strategy, m.chunk_max_chars, m.chunk_overlap_chars,
           m.keywords, m.domain, m.date_published, m.date_uploaded, m.language,
           o.slug AS organization_slug, p.slug AS project_slug, p.name AS project_name
    FROM \`${config.DB_TABLE_METADATA}\` m
    LEFT JOIN \`${config.DB_TABLE_ORGANIZATIONS}\` o ON m.organization_id = o.organization_id
    LEFT JOIN \`${config.DB_TABLE_PROJECTS}\` p ON m.project_id = p.project_id
    ${whereClause}
    ORDER BY m.date_uploaded DESC
  `,
    params
  );
  const memberships = await dbQuery(`SELECT dp.document_id, dp.project_id FROM \`${config.DB_TABLE_DOCUMENT_PROJECTS}\` dp
    JOIN \`${config.DB_TABLE_METADATA}\` m ON m.document_id = dp.document_id
    ${whereClause} ORDER BY dp.project_id`, params);
  const byDocument = new Map<number, number[]>();
  for (const row of memberships as any[]) {
    const ids = byDocument.get(Number(row.document_id)) || [];
    ids.push(Number(row.project_id));
    byDocument.set(Number(row.document_id), ids);
  }
  return (docs as any[]).map(doc => ({ ...doc, project_ids: byDocument.get(Number(doc.document_id)) || [] }));
};

export const searchDocuments = async (
  query: string,
  document_ids: number[] = [],
  projectIds: number[],
  organizationId: number | null,
  globalScope = false
): Promise<SearchResponse> => {
  if (!query) {
    return {
      citations: [],
      error: "query is required",
      status: 400,
    };
  }

  return {
    citations: (await retrieve(query, organizationId, projectIds, document_ids, 25, 5, globalScope)) as SearchResult[],
  };
};

export async function searchReturnHelper(query: string, result: SearchResponse) {
  if (result.error) {
    return {
      content: [{ type: "text", text: `Error: ${result.error}` }],
      structuredContent: { citations: [], query },
      isError: true,
    };
  }

  const citations = result.citations ?? [];

  if (!citations || citations.length === 0) {
    return {
      content: [{ type: "text", text: "There are no search results to your query." }],
      structuredContent: { citations: citations ?? [], query },
    };
  }

  const prompt = `You are an expert assistant.\n  Answer the query using only the provided citations.\n
  If the answer is not contained in the context, say "I don't know."`;
  return {
    content: [{ type: "text", text: JSON.stringify(citations) }],
    annotations: citations ?? [],
    structuredContent: { citations: citations ?? [], query, prompt },
  };

}
