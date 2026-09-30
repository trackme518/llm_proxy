import { getDocumentProjects, setDocumentProjects } from "../document_projects.js";
import crypto from "crypto";
import { addProject, listProjects } from "../auth.js";
import { config, logger } from "../config.js";
import { embedText, prepareChunksAndEmbeddings, recalculateDocumentEmbeddings } from "../embeddings.js";
import { query, sanitizeDate, sanitizeString, withTransaction } from "../db.js";
import { chunkText, TextChunk } from "../chunking.js";

export type CrawlerScope = "single_page" | "whole_domain";
export type CrawlerJobState = "processing" | "failed" | "finished";

export type CrawlerConfigRecord = {
  crawler_id: number;
  organization_id: number;
  url: string;
  domain_host: string;
  scope: CrawlerScope;
  use_sitemap: boolean;
  max_pages: number;
  use_llm_description: boolean;
  use_cron: boolean;
  cron_interval_minutes: number | null;
  cron_start_time: string | null;
  enabled: boolean;
  last_run_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

type CrawlerJob = {
  job_id: string;
  crawler_id: number;
  organization_id: number;
  url: string;
  progress: number;
  total: number;
  state: CrawlerJobState;
  error: string | null;
  expiresAt: number | null;
};


type CrawledPage = {
  url: string;
  canonicalUrl: string;
  title: string;
  author: string | null;
  description: string | null;
  keywords: string[] | null;
  language: string;
  languageDefined: string | null;
  markdown: string;
  datePublished: string | null;
};

type ExistingDocument = {
  document_id: number;
  domain: string | null;
  date_published: string | null;
  content_hash: string | null;
};

const CRAWLER_JOB_RETENTION_MS = 60_000;
const DEFAULT_CRAWLER_MAX_PAGES = 300;
const CRAWLER_PAGE_BATCH_SIZE = 10;
const CRAWLER_CHUNK_BATCH_SIZE = 200;
const DB_CHUNK_INSERT_BATCH_SIZE = 200;
const SCHEDULER_POLL_MS = 60_000;

const crawlerJobs = new Map<string, CrawlerJob>();
let activeCrawlerJobId: string | null = null;
const cancelledCrawlerJobIds = new Set<string>();
let schedulerStarted = false;

// =====================================
// URL + hashing helpers
// =====================================

const normalizeUrl = (value: string): URL => {
  const parsed = new URL(value);
  parsed.hash = "";
  return parsed;
};

const normalizeHost = (value: string): string => value.trim().toLowerCase();

const canonicalizeUrl = (value: string): string => {
  const parsed = normalizeUrl(value);
  parsed.protocol = parsed.protocol.toLowerCase();
  parsed.hostname = parsed.hostname.toLowerCase();
  parsed.pathname = parsed.pathname.length > 1 ? parsed.pathname.replace(/\/+$/, "") : parsed.pathname;
  return parsed.toString();
};

const buildContentHash = (canonicalUrl: string, markdown: string): string =>
  crypto.createHash("sha256").update(`${canonicalUrl}\n${markdown.trim()}`).digest("hex");

const sanitizeProjectSlug = (host: string): string => {
  const cleaned = host.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  const base = cleaned.length >= 3 ? cleaned : `web-${cleaned || "site"}`;
  return base.slice(0, 120);
};

const titleFromUrl = (value: string): string => {
  try {
    const parsed = new URL(value);
    const path = parsed.pathname === "/" ? parsed.hostname : `${parsed.hostname}${parsed.pathname}`;
    return path.slice(0, 500);
  } catch {
    return value.slice(0, 500);
  }
};

const mapCrawlerRow = (row: any): CrawlerConfigRecord => ({
  crawler_id: Number(row.crawler_id),
  organization_id: Number(row.organization_id),
  url: String(row.url),
  domain_host: String(row.domain_host),
  scope: row.scope === "whole_domain" ? "whole_domain" : "single_page",
  use_sitemap: row.use_sitemap == null ? true : Number(row.use_sitemap) === 1,
  max_pages: parseCrawlerMaxPages(row.max_pages),
  use_llm_description: Number(row.use_llm_description) === 1,
  use_cron: Number(row.use_cron) === 1,
  cron_interval_minutes: row.cron_interval_minutes == null ? null : Number(row.cron_interval_minutes),
  cron_start_time: row.cron_start_time == null ? null : String(row.cron_start_time),
  enabled: Number(row.enabled) === 1,
  last_run_at: row.last_run_at == null ? null : String(row.last_run_at),
  last_success_at: row.last_success_at == null ? null : String(row.last_success_at),
  last_error: row.last_error == null ? null : String(row.last_error),
  created_at: String(row.created_at),
  updated_at: String(row.updated_at),
});

// =====================================
// Crawler table CRUD
// =====================================

export async function saveCrawlerConfig(input: {
  crawlerId?: number | null;
  organizationId: number;
  url: string;
  scope: CrawlerScope;
  useSitemap: boolean;
  maxPages: number;
  useLlmDescription: boolean;
  useCron: boolean;
  cronIntervalMinutes: number | null;
  cronStartTime: string | null;
}): Promise<CrawlerConfigRecord> {
  const normalized = normalizeUrl(input.url);
  const normalizedUrl = normalized.toString();
  const host = normalizeHost(normalized.hostname);

  if (input.crawlerId && input.crawlerId > 0) {
    await query(
      `UPDATE \`domain_crawlers\`
       SET url = ?, domain_host = ?, scope = ?, use_sitemap = ?, max_pages = ?, use_llm_description = ?, use_cron = ?, cron_interval_minutes = ?, cron_start_time = ?, enabled = 1, updated_at = CURRENT_TIMESTAMP
       WHERE crawler_id = ? AND organization_id = ?`,
      [
        normalizedUrl,
        host,
        input.scope,
        input.useSitemap ? 1 : 0,
        input.maxPages,
        input.useLlmDescription ? 1 : 0,
        input.useCron ? 1 : 0,
        input.cronIntervalMinutes,
        input.cronStartTime,
        input.crawlerId,
        input.organizationId,
      ]
    );
  } else {
    await query(
      `INSERT INTO \`domain_crawlers\`
      (organization_id, url, domain_host, scope, use_sitemap, max_pages, use_llm_description, use_cron, cron_interval_minutes, cron_start_time, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON DUPLICATE KEY UPDATE
      scope = VALUES(scope),
      use_sitemap = VALUES(use_sitemap),
      max_pages = VALUES(max_pages),
      use_llm_description = VALUES(use_llm_description),
      use_cron = VALUES(use_cron),
      cron_interval_minutes = VALUES(cron_interval_minutes),
      cron_start_time = VALUES(cron_start_time),
      enabled = 1,
      updated_at = CURRENT_TIMESTAMP`,
      [
        input.organizationId,
        normalizedUrl,
        host,
        input.scope,
        input.useSitemap ? 1 : 0,
        input.maxPages,
        input.useLlmDescription ? 1 : 0,
        input.useCron ? 1 : 0,
        input.cronIntervalMinutes,
        input.cronStartTime,
      ]
    );
  }

  const rows = await query(
    `SELECT * FROM \`domain_crawlers\` WHERE organization_id = ? AND url = ? LIMIT 1`,
    [input.organizationId, normalizedUrl]
  );
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("Failed to save crawler configuration");
  }
  return mapCrawlerRow(rows[0]);
}

export async function listCrawlerConfigs(organizationId: number): Promise<CrawlerConfigRecord[]> {
  const rows = await query(
    `SELECT * FROM \`domain_crawlers\` WHERE organization_id = ? ORDER BY created_at DESC`,
    [organizationId]
  );
  return Array.isArray(rows) ? rows.map(mapCrawlerRow) : [];
}

export async function deleteCrawlerConfig(organizationId: number, crawlerId: number): Promise<boolean> {
  const result = await query(
    `DELETE FROM \`domain_crawlers\` WHERE organization_id = ? AND crawler_id = ?`,
    [organizationId, crawlerId]
  );
  return Number(result?.affectedRows ?? 0) > 0;
}

async function getCrawlerConfig(organizationId: number, crawlerId: number): Promise<CrawlerConfigRecord | null> {
  const rows = await query(
    `SELECT * FROM \`domain_crawlers\` WHERE organization_id = ? AND crawler_id = ? LIMIT 1`,
    [organizationId, crawlerId]
  );
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return mapCrawlerRow(rows[0]);
}

async function getDueCronCrawler(): Promise<CrawlerConfigRecord | null> {
  const rows = await query(
    `SELECT *
     FROM \`domain_crawlers\`
     WHERE enabled = 1
       AND use_cron = 1
       AND (
         last_run_at IS NULL
         OR (cron_interval_minutes IS NOT NULL AND TIMESTAMPDIFF(MINUTE, last_run_at, NOW()) >= cron_interval_minutes)
       )
       AND (cron_start_time IS NULL OR TIME(NOW()) >= cron_start_time)
     ORDER BY last_run_at IS NULL DESC, last_run_at ASC, crawler_id ASC
     LIMIT 1`
  );
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return mapCrawlerRow(rows[0]);
}

// =====================================
// Job lifecycle helpers
// =====================================

const cleanupCrawlerJobs = () => {
  const now = Date.now();
  for (const [jobId, job] of crawlerJobs.entries()) {
    if (job.expiresAt !== null && job.expiresAt <= now) {
      crawlerJobs.delete(jobId);
    }
  }
};

const createCrawlerJob = (organizationId: number, crawler: CrawlerConfigRecord): CrawlerJob => {
  cleanupCrawlerJobs();
  const job: CrawlerJob = {
    job_id: crypto.randomUUID(),
    crawler_id: crawler.crawler_id,
    organization_id: organizationId,
    url: crawler.url,
    progress: 0,
    total: 0,
    state: "processing",
    error: null,
    expiresAt: null,
  };
  crawlerJobs.set(job.job_id, job);
  activeCrawlerJobId = job.job_id;
  return job;
};

const updateCrawlerJob = (jobId: string, patch: Partial<CrawlerJob>) => {
  const current = crawlerJobs.get(jobId);
  if (!current) return;
  crawlerJobs.set(jobId, { ...current, ...patch });
};

const finishCrawlerJob = (jobId: string, state: Extract<CrawlerJobState, "failed" | "finished">, error: string | null = null) => {
  updateCrawlerJob(jobId, {
    state,
    error,
    expiresAt: Date.now() + CRAWLER_JOB_RETENTION_MS,
  });
  if (activeCrawlerJobId === jobId) {
    activeCrawlerJobId = null;
  }
  cancelledCrawlerJobIds.delete(jobId);
};

export const getCrawlerStatus = (jobId: string | null) => {
  cleanupCrawlerJobs();
  if (!jobId) {
    const active = activeCrawlerJobId ? crawlerJobs.get(activeCrawlerJobId) : null;
    if (!active) return { progress: 0, total: 0, state: "not found", active_job_id: null };
    return {
      progress: active.progress,
      total: active.total,
      state: active.state,
      active_job_id: active.job_id,
      crawler_id: active.crawler_id,
      organization_id: active.organization_id,
      error: active.error,
    };
  }

  const job = crawlerJobs.get(jobId);
  if (!job) return { progress: 0, total: 0, state: "not found", active_job_id: activeCrawlerJobId };
  return {
    progress: job.progress,
    total: job.total,
    state: job.state,
    active_job_id: activeCrawlerJobId,
    crawler_id: job.crawler_id,
    organization_id: job.organization_id,
    error: job.error,
  };
};

export const hasActiveCrawlerJob = (): boolean => {
  if (!activeCrawlerJobId) return false;
  const active = crawlerJobs.get(activeCrawlerJobId);
  return !!active && active.state === "processing";
};

const isCrawlerJobCancelled = (jobId: string): boolean => {
  const current = crawlerJobs.get(jobId);
  return !current || current.state !== "processing" || cancelledCrawlerJobIds.has(jobId);
};

const throwIfCrawlerCancelled = (jobId: string) => {
  if (isCrawlerJobCancelled(jobId)) {
    throw new Error("Crawler cancelled by user");
  }
};

export const stopActiveCrawlerJob = (
  organizationId: number
): { stopped: boolean; job_id: string | null; error?: string } => {
  cleanupCrawlerJobs();
  if (!activeCrawlerJobId) {
    return { stopped: false, job_id: null, error: "No active crawler job" };
  }

  const active = crawlerJobs.get(activeCrawlerJobId);
  if (!active || active.state !== "processing") {
    return { stopped: false, job_id: null, error: "No active crawler job" };
  }

  if (Number(active.organization_id) !== Number(organizationId)) {
    return { stopped: false, job_id: active.job_id, error: "No active crawler job for this organization" };
  }

  cancelledCrawlerJobIds.add(active.job_id);
  updateCrawlerJob(active.job_id, { error: "Cancellation requested" });
  return { stopped: true, job_id: active.job_id };
};

// =====================================
// Crawler service + LLM clients
// =====================================

const crawlerServiceUrl = () =>
  (String(process.env.CRAWLER_URL || process.env.CRAWL4AI_URL || "http://crawler:11235")).replace(/\/$/, "");
const litellmBase = () => (String(process.env.INTERNAL_LITELLM_URL || "http://litellm:8001")).replace(/\/$/, "");

const crawlerFetch = async (path: string, body: Record<string, unknown>) => {
  const response = await fetch(`${crawlerServiceUrl()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.REQUEST_TIMEOUT),
  });

  const raw = await response.text();
  let data: any = null;
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = raw;
    }
  }

  if (!response.ok) {
    throw new Error(typeof data?.error === "string" ? data.error : `Crawler service request failed (${response.status})`);
  }
  return data;
};

const parseBcp47LanguageTag = (value: string | null | undefined): string | null => {
  const raw = sanitizeString(value, 64);
  if (!raw) return null;

  const normalized = raw.replace(/_/g, "-").trim();
  const parts = normalized.split("-").filter(Boolean);
  if (parts.length === 0) return null;

  const primary = parts[0].toLowerCase();
  if (!/^[a-z]{2,3}$/.test(primary)) return null;

  const rest = parts
    .slice(1)
    .map((part) => {
      if (/^[a-z]{4}$/i.test(part)) {
        return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
      }
      if (/^[a-z]{2}$/i.test(part) || /^\d{3}$/.test(part)) {
        return part.toUpperCase();
      }
      if (/^[a-z0-9]{5,8}$/i.test(part)) {
        return part.toLowerCase();
      }
      return "";
    })
    .filter(Boolean);

  return [primary, ...rest].join("-") || null;
};

const extractHtmlLang = (html: string | null | undefined): string | null => {
  const source = typeof html === "string" ? html : "";
  const match = source.match(/<html\b[^>]*\blang\s*=\s*["']?([^"'\s>]+)/i);
  return parseBcp47LanguageTag(match?.[1] ?? null);
};

const parseKeywords = (value: unknown): string[] | null => {
  const candidates = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? [value]
      : [];

  const cleaned = candidates
    .flatMap((item) => String(item).split(/[|,;\n]+/))
    .map((item) => sanitizeString(item, 120))
    .filter((item): item is string => !!item);

  return cleaned.length > 0 ? cleaned : null;
};

const parseCrawlResult = (requestedUrl: string, result: any): CrawledPage => {
  const metadata = result?.metadata && typeof result.metadata === "object" ? result.metadata : {};
  const resolvedUrl = sanitizeString(result?.url || requestedUrl, 2000) || requestedUrl;
  const canonicalUrl = canonicalizeUrl(resolvedUrl);

  const markdown =
    sanitizeString(result?.markdown?.fit_markdown) ||
    sanitizeString(result?.markdown?.raw_markdown) ||
    sanitizeString(result?.markdown) ||
    sanitizeString(metadata?.content_markdown) ||
    sanitizeString(result?.cleaned_html) ||
    sanitizeString(result?.html) ||
    "";

  const extractedDate = sanitizeDate(metadata?.date);
  const fallbackLastModified = sanitizeDate(metadata?.last_modified);

  const metadataLanguageRaw = sanitizeString(metadata?.language, 64);
  const metadataLanguage = parseBcp47LanguageTag(metadataLanguageRaw);
  const htmlLanguage = extractHtmlLang(result?.html || result?.cleaned_html);
  const languageDefined = metadataLanguage || htmlLanguage || null;

  return {
    url: resolvedUrl,
    canonicalUrl,
    title: sanitizeString(metadata?.title, 500) || titleFromUrl(resolvedUrl),
    author: sanitizeString(metadata?.author, 255),
    description: sanitizeString(metadata?.description),
    keywords: parseKeywords(metadata?.keywords),
    language: languageDefined || "en",
    languageDefined,
    markdown,
    datePublished: extractedDate || fallbackLastModified || null,
  };
};

const crawlWholeDomain = async (
  url: string,
  maxPages: number,
  useSitemap: boolean
): Promise<CrawledPage[]> => {
  const payload = await crawlerFetch("/crawl", {
    url,
    scope: "whole_domain",
    use_sitemap: useSitemap,
    max_urls: maxPages,
    max_depth: 3,
  });

  const results = Array.isArray(payload?.results)
    ? payload.results
    : payload?.result
      ? [payload.result]
      : [];

  const pages: CrawledPage[] = [];
  for (const result of results) {
    if (!result || result.success === false) continue;
    pages.push(parseCrawlResult(url, result));
  }

  return pages;
};

const fetchLastModifiedDate = async (url: string): Promise<string | null> => {
  try {
    const response = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });

    const header = response.headers.get("last-modified");
    if (!header) return null;
    return sanitizeDate(header);
  } catch {
    return null;
  }
};

const generateSummaryWithLiteLlm = async (markdown: string): Promise<string> => {
  const prompt = [
    "Create exactly one sentence describing this webpage content.",
    "Do not use bullet points.",
    "If content is empty, return empty string.",
    "Content:",
    markdown.slice(0, 12_000),
  ].join("\n\n");

  const extractSummaryText = (data: any): string => {
    const output = sanitizeString(data?.output_text);
    if (output) return output.slice(0, 1000);

    const list = Array.isArray(data?.output) ? data.output : [];
    for (const item of list) {
      if (item?.type !== "message" || item?.role !== "assistant") continue;
      const content = Array.isArray(item?.content) ? item.content : [];
      for (const contentItem of content) {
        const text = sanitizeString(contentItem?.text);
        if (text) return text.slice(0, 1000);
      }
    }

    return "";
  };

  try {
    const site = "crawler_summary_local";

    const authRes = await fetch(`${litellmBase()}/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ site }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!authRes.ok) return "";
    const authData: any = await authRes.json();
    const token = sanitizeString(authData?.token, 512);
    if (!token) return "";

    const responseRes = await fetch(`${litellmBase()}/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ input: prompt, site }),
      signal: AbortSignal.timeout(25_000),
    });

    if (!responseRes.ok) return "";
    const data: any = await responseRes.json();
    return extractSummaryText(data);
  } catch (error) {
    logger.warn({ err: error }, "Failed to generate page summary with litellm");
    return "";
  }
};

// =====================================
// Crawl execution + document sync
// =====================================

const crawlSinglePage = async (
  jobId: string,
  url: string,
  lastModifiedHints?: Map<string, string | null>
): Promise<CrawledPage> => {
  const payload = await crawlerFetch("/crawl", {
    url,
    scope: "single_page",
    max_urls: 1,
  });

  const results = Array.isArray(payload?.results)
    ? payload.results
    : payload?.result
      ? [payload.result]
      : [];

  const pages: CrawledPage[] = [];
  for (const result of results) {
    if (!result || result.success === false) continue;
    pages.push(parseCrawlResult(url, result));
  }

  await Promise.all(
    pages.map(async (page) => {
      throwIfCrawlerCancelled(jobId);
      const hint = lastModifiedHints?.get(page.canonicalUrl) ?? null;
      if (!page.datePublished) {
        page.datePublished = hint ?? await fetchLastModifiedDate(page.url);
      }
    })
  );

  if (pages.length === 0) {
    throw new Error(`Crawl returned no usable page for ${url}`);
  }

  return pages[0];
};

async function ensureDomainProject(organizationId: number, domainHost: string): Promise<number> {
  const projects = await listProjects(organizationId);
  const byName = projects.find((p) => normalizeHost(p.name) === normalizeHost(domainHost));
  if (byName) return Number(byName.project_id);

  const slug = sanitizeProjectSlug(domainHost);
  try {
    const created = await addProject(organizationId, slug, domainHost);
    return Number(created.project_id);
  } catch {
    const refreshed = await listProjects(organizationId);
    const existing = refreshed.find((p) => p.slug === slug || normalizeHost(p.name) === normalizeHost(domainHost));
    if (existing) return Number(existing.project_id);
    throw new Error(`Failed to resolve project for domain ${domainHost}`);
  }
}

const loadProjectDocuments = async (organizationId: number, projectId: number): Promise<ExistingDocument[]> => {
  const rows = await query(
    `SELECT document_id, domain, date_published, content_hash
     FROM \`${config.DB_TABLE_METADATA}\` m
     WHERE organization_id = ? AND EXISTS (SELECT 1 FROM \`${config.DB_TABLE_DOCUMENT_PROJECTS}\` dp WHERE dp.document_id = m.document_id AND dp.project_id = ?)`,
    [organizationId, projectId]
  );

  return Array.isArray(rows)
    ? rows.map((row: any) => ({
      document_id: Number(row.document_id),
      domain: row.domain == null ? null : String(row.domain),
      date_published: row.date_published == null ? null : String(row.date_published),
      content_hash: row.content_hash == null ? null : String(row.content_hash),
    }))
    : [];
};

const shouldUpdateDocument = (existing: ExistingDocument | null, incomingDate: string | null, incomingContentHash: string): boolean => {
  if (!existing) return true;
  if (existing.content_hash !== incomingContentHash) return true;
  if (!incomingDate || !existing.date_published) return false;
  return new Date(incomingDate).getTime() > new Date(existing.date_published).getTime();
};

const insertDocumentFromPage = async (organizationId: number, projectId: number, page: CrawledPage) => {
  const contentHash = buildContentHash(page.canonicalUrl, page.markdown);
  const { chunks, embeddings } = await prepareChunksAndEmbeddings(page.markdown, {
    strategy: "semantic",
    maxChars: 1000,
    overlapChars: 250,
    minChars: 0,
  });

  await withTransaction(async (conn) => {
    const docResult = await conn.query(
      `INSERT INTO \`${config.DB_TABLE_METADATA}\`
      (organization_id, project_id, title, author, summary, content, chunking_strategy, chunk_max_chars, chunk_overlap_chars, keywords, domain, date_published, language, content_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        organizationId,
        projectId,
        page.title,
        page.author || null,
        page.description || null,
        page.markdown,
        "semantic",
        1000,
        250,
        page.keywords ? JSON.stringify(page.keywords) : null,
        page.canonicalUrl,
        page.datePublished,
        page.language,
        contentHash,
      ]
    );

    const documentId = Number(docResult.insertId);
    await setDocumentProjects(conn, documentId, organizationId, [projectId]);
    const placeholders: string[] = [];
    const values: any[] = [];

    for (let i = 0; i < chunks.length; i += 1) {
      placeholders.push("(?, ?, ?, ?, ?, VEC_FromText(?))");
      values.push(organizationId, documentId, i, chunks[i].start, chunks[i].text, JSON.stringify(embeddings[i]));
    }

    if (placeholders.length > 0) {
      await conn.query(
        `INSERT INTO \`${config.DB_TABLE_CHUNKS}\` (organization_id, document_id, chunk_id, chunk_start, content, embedding)
         VALUES ${placeholders.join(", ")}`,
        values
      );
    }
  });
};

const updateDocumentFromPage = async (organizationId: number, documentId: number, page: CrawledPage) => {
  const contentHash = buildContentHash(page.canonicalUrl, page.markdown);
  await query(
    `UPDATE \`${config.DB_TABLE_METADATA}\`
     SET title = ?, author = ?, summary = ?, content = ?, keywords = ?, domain = ?, date_published = ?, language = ?, content_hash = ?
     WHERE organization_id = ? AND document_id = ?`,
    [
      page.title,
      page.author || null,
      page.description || null,
      page.markdown,
      page.keywords ? JSON.stringify(page.keywords) : null,
      page.canonicalUrl,
      page.datePublished,
      page.language,
      contentHash,
      organizationId,
      documentId,
    ]
  );

  await recalculateDocumentEmbeddings(documentId, organizationId, false);
};

const chunkPageForSync = async (page: CrawledPage): Promise<TextChunk[]> => {
  return chunkText(page.markdown, {
    strategy: "semantic",
    maxChars: 1000,
    overlapChars: 250,
    minChars: 0,
    language: page.language || undefined,
  });
};

const insertChunksForDocument = async (
  conn: any,
  organizationId: number,
  documentId: number,
  chunks: TextChunk[],
  embeddings: number[][]
) => {
  if (chunks.length === 0) {
    return;
  }

  if (chunks.length !== embeddings.length) {
    throw new Error(`Chunk/embedding length mismatch for document ${documentId}`);
  }

  for (let i = 0; i < chunks.length; i += DB_CHUNK_INSERT_BATCH_SIZE) {
    const end = Math.min(i + DB_CHUNK_INSERT_BATCH_SIZE, chunks.length);
    const placeholders: string[] = [];
    const values: any[] = [];

    for (let j = i; j < end; j += 1) {
      placeholders.push("(?, ?, ?, ?, ?, VEC_FromText(?))");
      values.push(organizationId, documentId, j, chunks[j].start, chunks[j].text, JSON.stringify(embeddings[j]));
    }

    await conn.query(
      `INSERT INTO \`${config.DB_TABLE_CHUNKS}\` (organization_id, document_id, chunk_id, chunk_start, content, embedding)
       VALUES ${placeholders.join(", ")}`,
      values
    );
  }
};

const upsertPageWithPreparedChunks = async (
  organizationId: number,
  projectId: number,
  page: CrawledPage,
  existingDocumentId: number | null,
  chunks: TextChunk[],
  embeddings: number[][]
) => {
  const contentHash = buildContentHash(page.canonicalUrl, page.markdown);

  await withTransaction(async (conn) => {
    let documentId = existingDocumentId;

    if (documentId) {
      await conn.query(
        `UPDATE \`${config.DB_TABLE_METADATA}\`
         SET title = ?, author = ?, summary = ?, content = ?, keywords = ?, domain = ?, date_published = ?, language = ?, content_hash = ?
         WHERE organization_id = ? AND document_id = ?`,
        [
          page.title,
          page.author || null,
          page.description || null,
          page.markdown,
          page.keywords ? JSON.stringify(page.keywords) : null,
          page.canonicalUrl,
          page.datePublished,
          page.language,
          contentHash,
          organizationId,
          documentId,
        ]
      );

      await conn.query(
        `DELETE FROM \`${config.DB_TABLE_CHUNKS}\` WHERE organization_id = ? AND document_id = ?`,
        [organizationId, documentId]
      );
    } else {
      const docResult = await conn.query(
        `INSERT INTO \`${config.DB_TABLE_METADATA}\`
        (organization_id, project_id, title, author, summary, content, chunking_strategy, chunk_max_chars, chunk_overlap_chars, keywords, domain, date_published, language, content_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          organizationId,
          projectId,
          page.title,
          page.author || null,
          page.description || null,
          page.markdown,
          "semantic",
          1000,
          250,
          page.keywords ? JSON.stringify(page.keywords) : null,
          page.canonicalUrl,
          page.datePublished,
          page.language,
          contentHash,
        ]
      );

      documentId = Number(docResult.insertId);
      await setDocumentProjects(conn, documentId, organizationId, [projectId]);
    }

    if (!documentId) {
      throw new Error("Failed to resolve document_id while syncing crawled page");
    }

    await insertChunksForDocument(conn, organizationId, documentId, chunks, embeddings);
  });
};

const deleteDocumentById = async (organizationId: number, projectId: number, documentId: number) => {
  await withTransaction(async conn => {
    const docs = await conn.query(`SELECT document_id FROM \`${config.DB_TABLE_METADATA}\` WHERE organization_id = ? AND document_id = ? FOR UPDATE`, [organizationId, documentId]);
    if (!docs.length) return;
    const remaining = (await getDocumentProjects(conn, documentId)).filter(id => id !== projectId);
    if (remaining.length) {
      await setDocumentProjects(conn, documentId, organizationId, remaining);
    } else {
      await conn.query(`DELETE FROM \`${config.DB_TABLE_METADATA}\` WHERE organization_id = ? AND document_id = ?`, [organizationId, documentId]);
    }
  });
};

type ProjectSyncState = {
  projectId: number;
  existingDocs: ExistingDocument[];
  existingByUrl: Map<string, ExistingDocument>;
  seenUrls: Set<string>;
};

const normalizeDocumentUrlKey = (value: string | null | undefined): string | null => {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;
  try {
    return canonicalizeUrl(raw);
  } catch {
    return null;
  }
};

async function createProjectSyncState(organizationId: number, projectId: number): Promise<ProjectSyncState> {
  const existingDocs = await loadProjectDocuments(organizationId, projectId);
  const existingByUrl = new Map<string, ExistingDocument>();

  for (const doc of existingDocs) {
    const urlKey = normalizeDocumentUrlKey(doc.domain);
    if (!urlKey) continue;
    existingByUrl.set(urlKey, doc);
  }

  return {
    projectId,
    existingDocs,
    existingByUrl,
    seenUrls: new Set<string>(),
  };
}

async function syncPageToProject(
  jobId: string,
  organizationId: number,
  projectId: number,
  state: ProjectSyncState,
  page: CrawledPage,
  useLlmDescription: boolean
) {
  const urlKey = page.canonicalUrl;
  state.seenUrls.add(urlKey);

  const existing = state.existingByUrl.get(urlKey) || null;
  const newContentHash = buildContentHash(page.canonicalUrl, page.markdown);
  const needsUpdate = shouldUpdateDocument(existing, page.datePublished, newContentHash);

  if (!needsUpdate) return;

  if (!page.description && useLlmDescription) {
    const generatedSummary = await generateSummaryWithLiteLlm(page.markdown);
    page.description = sanitizeString(generatedSummary, 1000);
  }

  if (existing) {
    await updateDocumentFromPage(organizationId, existing.document_id, page);
    return;
  }

  await insertDocumentFromPage(organizationId, projectId, page);
}

const shouldSkipExistingPageByLastModified = async (
  url: string,
  state: ProjectSyncState,
  lastModifiedHints: Map<string, string | null>
): Promise<{ skip: boolean; urlKey: string }> => {
  const canonicalUrl = canonicalizeUrl(url);
  const existing = state.existingByUrl.get(canonicalUrl) || null;

  if (!existing?.date_published) {
    return { skip: false, urlKey: canonicalUrl };
  }

  const lastModified = await fetchLastModifiedDate(url);
  lastModifiedHints.set(canonicalUrl, lastModified);

  if (!lastModified) {
    return { skip: false, urlKey: canonicalUrl };
  }

  const remoteTime = new Date(lastModified).getTime();
  const localTime = new Date(existing.date_published).getTime();
  if (!Number.isFinite(remoteTime) || !Number.isFinite(localTime)) {
    return { skip: false, urlKey: canonicalUrl };
  }

  return { skip: remoteTime <= localTime, urlKey: canonicalUrl };
};

async function finalizeProjectSync(organizationId: number, state: ProjectSyncState, jobId: string) {
  throwIfCrawlerCancelled(jobId);
  for (const doc of state.existingDocs) {
    const urlKey = normalizeDocumentUrlKey(doc.domain);
    if (!urlKey) continue;
    if (state.seenUrls.has(urlKey)) continue;
    await deleteDocumentById(organizationId, state.projectId, doc.document_id);
  }
}

async function runCrawler(
  organizationId: number,
  crawler: CrawlerConfigRecord,
  jobId: string
): Promise<void> {
  throwIfCrawlerCancelled(jobId);

  await query(
    `UPDATE \`domain_crawlers\` SET last_run_at = NOW(), last_error = NULL WHERE organization_id = ? AND crawler_id = ?`,
    [organizationId, crawler.crawler_id]
  );

  // Ensure project exists as early as possible (even before crawl results are synced).
  const projectId = await ensureDomainProject(organizationId, crawler.domain_host);
  throwIfCrawlerCancelled(jobId);
  const syncState = await createProjectSyncState(organizationId, projectId);
  const lastModifiedHints = new Map<string, string | null>();

  let sawChangesOrSkips = false;

  const onPage = async (page: CrawledPage) => {
    throwIfCrawlerCancelled(jobId);
    sawChangesOrSkips = true;
    await syncPageToProject(jobId, organizationId, projectId, syncState, page, crawler.use_llm_description);
  };

  const onSkipUrl = async (urlKey: string) => {
    sawChangesOrSkips = true;
    syncState.seenUrls.add(urlKey);
  };

  if (crawler.scope === "single_page") {
    updateCrawlerJob(jobId, { progress: 0, total: 1 });

    const skipDecision = await shouldSkipExistingPageByLastModified(crawler.url, syncState, lastModifiedHints);
    if (skipDecision.skip) {
      await onSkipUrl(skipDecision.urlKey);
      updateCrawlerJob(jobId, { progress: 1, total: 1 });
    } else {
      throwIfCrawlerCancelled(jobId);
      const page = await crawlSinglePage(jobId, crawler.url, lastModifiedHints);
      await onPage(page);
      updateCrawlerJob(jobId, { progress: 1, total: 1 });
    }
  } else {
    const pages = await crawlWholeDomain(crawler.url, crawler.max_pages, crawler.use_sitemap);
    if (pages.length === 0) {
      throw new Error("No crawlable URLs found for domain crawl");
    }

    updateCrawlerJob(jobId, { progress: 0, total: pages.length });
    let processed = 0;

    for (let batchStart = 0; batchStart < pages.length; batchStart += CRAWLER_PAGE_BATCH_SIZE) {
      throwIfCrawlerCancelled(jobId);
      const pageBatch = pages.slice(batchStart, batchStart + CRAWLER_PAGE_BATCH_SIZE);
      const pending: Array<{ page: CrawledPage; existingDocumentId: number | null; chunks: TextChunk[] }> = [];

      for (const page of pageBatch) {
        throwIfCrawlerCancelled(jobId);
        sawChangesOrSkips = true;

        const urlKey = page.canonicalUrl;
        syncState.seenUrls.add(urlKey);

        const existing = syncState.existingByUrl.get(urlKey) || null;
        const newContentHash = buildContentHash(page.canonicalUrl, page.markdown);
        const needsUpdate = shouldUpdateDocument(existing, page.datePublished, newContentHash);

        if (!needsUpdate) {
          processed += 1;
          updateCrawlerJob(jobId, { progress: processed, total: pages.length });
          continue;
        }

        if (!page.description && crawler.use_llm_description) {
          const generatedSummary = await generateSummaryWithLiteLlm(page.markdown);
          page.description = sanitizeString(generatedSummary, 1000);
        }

        const chunks = await chunkPageForSync(page);
        pending.push({
          page,
          existingDocumentId: existing?.document_id ?? null,
          chunks,
        });
      }

      if (pending.length === 0) {
        continue;
      }

      const flatChunkTexts: string[] = [];
      const chunkCounts: number[] = [];
      for (const item of pending) {
        chunkCounts.push(item.chunks.length);
        for (const chunk of item.chunks) {
          flatChunkTexts.push(chunk.text);
        }
      }

      const allEmbeddings: number[][] = [];
      for (let i = 0; i < flatChunkTexts.length; i += CRAWLER_CHUNK_BATCH_SIZE) {
        throwIfCrawlerCancelled(jobId);
        const batchEmbeddings = await embedText(flatChunkTexts.slice(i, i + CRAWLER_CHUNK_BATCH_SIZE));
        allEmbeddings.push(...batchEmbeddings);
      }

      if (allEmbeddings.length !== flatChunkTexts.length) {
        throw new Error(`Embedding count mismatch: expected ${flatChunkTexts.length}, got ${allEmbeddings.length}`);
      }

      let embeddingOffset = 0;
      for (let i = 0; i < pending.length; i += 1) {
        throwIfCrawlerCancelled(jobId);
        const item = pending[i];
        const chunkCount = chunkCounts[i];
        const pageEmbeddings = allEmbeddings.slice(embeddingOffset, embeddingOffset + chunkCount);
        embeddingOffset += chunkCount;

        await upsertPageWithPreparedChunks(
          organizationId,
          projectId,
          item.page,
          item.existingDocumentId,
          item.chunks,
          pageEmbeddings
        );

        processed += 1;
        updateCrawlerJob(jobId, { progress: processed, total: pages.length });
      }
    }
  }

  if (!sawChangesOrSkips) {
    throw new Error("Crawl returned no pages");
  }

  throwIfCrawlerCancelled(jobId);
  await finalizeProjectSync(organizationId, syncState, jobId);

  await query(
    `UPDATE \`domain_crawlers\` SET last_success_at = NOW(), last_error = NULL WHERE organization_id = ? AND crawler_id = ?`,
    [organizationId, crawler.crawler_id]
  );
}

export async function enqueueCrawlerRun(input: {
  organizationId: number;
  crawlerId?: number | null;
  url?: string | null;
  scope?: CrawlerScope | null;
  useSitemap?: boolean | null;
  maxPages?: number | null;
  useLlmDescription?: boolean | null;
  useCron?: boolean | null;
  cronIntervalMinutes?: number | null;
  cronStartTime?: string | null;
}): Promise<{ job_id: string; crawler_id: number } | { error: string }> {
  if (hasActiveCrawlerJob()) {
    return { error: "Another crawler job is already running" };
  }

  let crawler: CrawlerConfigRecord | null = null;
  if (input.crawlerId && input.crawlerId > 0) {
    crawler = await getCrawlerConfig(input.organizationId, input.crawlerId);
  }

  if (!crawler && input.crawlerId && input.crawlerId > 0) {
    return { error: "Crawler not found" };
  }

  if (!crawler) {
    const url = sanitizeString(input.url, 2000);
    const scope = input.scope === "whole_domain" ? "whole_domain" : "single_page";
    if (!url) return { error: "url is required" };

    crawler = await saveCrawlerConfig({
      organizationId: input.organizationId,
      url,
      scope,
      useSitemap: parseCrawlerUseSitemap(input.useSitemap),
      maxPages: parseCrawlerMaxPages(input.maxPages),
      useLlmDescription: parseCrawlerUseLlmDescription(input.useLlmDescription),
      useCron: Boolean(input.useCron),
      cronIntervalMinutes: input.cronIntervalMinutes ?? null,
      cronStartTime: input.cronStartTime ?? null,
    });
  }

  const job = createCrawlerJob(input.organizationId, crawler);

  void (async () => {
    try {
      await runCrawler(input.organizationId, crawler!, job.job_id);
      finishCrawlerJob(job.job_id, "finished", null);
    } catch (error: any) {
      const message = error?.message || String(error);
      await query(
        `UPDATE \`domain_crawlers\` SET last_error = ? WHERE organization_id = ? AND crawler_id = ?`,
        [message.slice(0, 2000), input.organizationId, crawler!.crawler_id]
      );
      finishCrawlerJob(job.job_id, "failed", message);
      logger.error({ err: error, crawlerId: crawler!.crawler_id }, "Crawler job failed");
    }
  })();

  return { job_id: job.job_id, crawler_id: crawler.crawler_id };
}

// =====================================
// Cron worker
// =====================================

export function startCrawlerScheduler() {
  if (schedulerStarted) return;
  schedulerStarted = true;

  const tick = async () => {
    if (hasActiveCrawlerJob()) return;
    try {
      const due = await getDueCronCrawler();
      if (!due) return;
      await enqueueCrawlerRun({ organizationId: due.organization_id, crawlerId: due.crawler_id });
    } catch (error) {
      logger.error({ err: error }, "Crawler scheduler tick failed");
    }
  };

  void tick();
  setInterval(() => {
    void tick();
  }, SCHEDULER_POLL_MS);
}

export const normalizeCrawlerUrl = (value: string): string => normalizeUrl(value).toString();

export const parseCronStartTime = (value: string | null | undefined): string | null => {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(trimmed) ? trimmed : null;
};

export const parseCronInterval = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  if (!Number.isInteger(num) || num <= 0) return null;
  return Math.min(10080, num); // max 7 days
};

export const parseCrawlerUseSitemap = (value: unknown): boolean => {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["0", "false", "no", "off"].includes(normalized)) return false;
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
  }
  return true;
};

export const parseCrawlerMaxPages = (value: unknown): number => {
  const num = Number(value);
  if (!Number.isInteger(num) || num <= 0) return DEFAULT_CRAWLER_MAX_PAGES;
  return Math.min(2000, num);
};

export const parseCrawlerUseLlmDescription = (value: unknown): boolean => {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["0", "false", "no", "off"].includes(normalized)) return false;
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
  }
  return false;
};

export async function createCrawlerTables(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS \`domain_crawlers\` (
      crawler_id INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
      organization_id INT UNSIGNED NOT NULL,
      url VARCHAR(2000) NOT NULL,
      domain_host VARCHAR(255) NOT NULL,
      scope ENUM('single_page','whole_domain') NOT NULL DEFAULT 'single_page',
      use_sitemap TINYINT(1) NOT NULL DEFAULT 1,
      max_pages INT UNSIGNED NOT NULL DEFAULT 300,
      use_llm_description TINYINT(1) NOT NULL DEFAULT 0,
      use_cron TINYINT(1) NOT NULL DEFAULT 0,
      cron_interval_minutes INT NULL,
      cron_start_time TIME NULL,
      enabled TINYINT(1) NOT NULL DEFAULT 1,
      last_run_at DATETIME NULL,
      last_success_at DATETIME NULL,
      last_error TEXT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (organization_id) REFERENCES \`${config.DB_TABLE_ORGANIZATIONS}\`(organization_id) ON DELETE CASCADE,
      UNIQUE KEY uq_crawler_org_url (organization_id, url),
      INDEX idx_crawler_org_enabled (organization_id, enabled),
      INDEX idx_crawler_cron_due (use_cron, enabled, last_run_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await query("ALTER TABLE `domain_crawlers` ADD COLUMN IF NOT EXISTS use_sitemap TINYINT(1) NOT NULL DEFAULT 1 AFTER scope");
  await query("ALTER TABLE `domain_crawlers` ADD COLUMN IF NOT EXISTS max_pages INT UNSIGNED NOT NULL DEFAULT 300 AFTER use_sitemap");
  await query("ALTER TABLE `domain_crawlers` ADD COLUMN IF NOT EXISTS use_llm_description TINYINT(1) NOT NULL DEFAULT 0 AFTER max_pages");
}

export async function runCrawlerNowForExisting(
  organizationId: number,
  crawlerId: number
): Promise<{ job_id: string; crawler_id: number } | { error: string }> {
  return enqueueCrawlerRun({ organizationId, crawlerId });
}

export async function createOrUpdateCrawlerAndMaybeRun(input: {
  organizationId: number;
  crawlerId?: number | null;
  url: string;
  scope: CrawlerScope;
  useSitemap: boolean;
  maxPages: number;
  useLlmDescription: boolean;
  useCron: boolean;
  cronIntervalMinutes: number | null;
  cronStartTime: string | null;
  runNow: boolean;
}): Promise<{ crawler: CrawlerConfigRecord; job_id: string | null } | { error: string }> {
  const crawler = await saveCrawlerConfig({
    crawlerId: input.crawlerId,
    organizationId: input.organizationId,
    url: input.url,
    scope: input.scope,
    useSitemap: input.useSitemap,
    maxPages: input.maxPages,
    useLlmDescription: input.useLlmDescription,
    useCron: input.useCron,
    cronIntervalMinutes: input.cronIntervalMinutes,
    cronStartTime: input.cronStartTime,
  });

  if (!input.runNow) {
    return { crawler, job_id: null };
  }

  const job = await enqueueCrawlerRun({ organizationId: input.organizationId, crawlerId: crawler.crawler_id });
  if ("error" in job) return job;
  return { crawler, job_id: job.job_id };
}

export const parseScope = (value: unknown): CrawlerScope =>
  value === "whole_domain" ? "whole_domain" : "single_page";

export default {
  saveCrawlerConfig,
  listCrawlerConfigs,
  deleteCrawlerConfig,
  enqueueCrawlerRun,
  getCrawlerStatus,
  hasActiveCrawlerJob,
  stopActiveCrawlerJob,
  startCrawlerScheduler,
  parseCronInterval,
  parseCronStartTime,
  parseCrawlerUseSitemap,
  parseCrawlerMaxPages,
  parseCrawlerUseLlmDescription,
  parseScope,
  normalizeCrawlerUrl,
  createCrawlerTables,
  createOrUpdateCrawlerAndMaybeRun,
  runCrawlerNowForExisting,
};
