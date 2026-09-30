import { createEmbeddingClient } from "../embedding_client.js";
type Json = Record<string, unknown>;

type CrawlResultItem = {
  markdown?: { fit_markdown?: string };
  success?: boolean;
  url?: string;
};

type CrawlResponse = {
  results?: CrawlResultItem[];
};

type SitemapResponse = {
  urls?: string[];
};

type RunMetrics = {
  totalMs: number;
  crawlMs: number;
  embedMs: number;
  pagesEmbedded: number;
};

const CRAWLER_BASE_URL = process.env.CRAWLER_BASE_URL || "http://crawler:11235";
const EMBEDDING_BASE_URL = process.env.EMBEDDINGS_URL || "http://embedding:8000/v1/embeddings";
const embed = createEmbeddingClient({ url: EMBEDDING_BASE_URL, model: process.env.EMBEDDINGS_MODEL || "google/embeddinggemma-300m", apiKey: process.env.EMBEDDINGS_API_KEY, timeoutMs: 300_000 });
const SITEMAP_SEED_URL = process.env.SITEMAP_SEED_URL || "https://www.muzeumprahy.cz/";
const PAGE_COUNT = Number(process.env.PAGE_COUNT || 10);
const REPEATS = Number(process.env.REPEATS || 3);

const requestJson = async <T>(
  url: string,
  init: RequestInit,
  timeoutMs = 300_000
): Promise<T> => {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });

  const raw = await response.text();
  let data: any = null;
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = { raw };
    }
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}: ${JSON.stringify(data)}`);
  }

  return (data ?? {}) as T;
};

const postJson = async <T>(url: string, body: Json, timeoutMs?: number): Promise<T> => {
  return requestJson<T>(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    timeoutMs
  );
};

const canonicalKey = (value: string): string => {
  const parsed = new URL(value);
  parsed.hash = "";
  parsed.pathname = parsed.pathname.length > 1 ? parsed.pathname.replace(/\/+$/, "") : parsed.pathname;
  return parsed.toString();
};

const toMarkdownList = (items: CrawlResultItem[] | undefined): string[] => {
  if (!Array.isArray(items)) return [];
  const list: string[] = [];

  for (const item of items) {
    if (item?.success === false) continue;
    const markdown = item?.markdown?.fit_markdown;
    if (typeof markdown !== "string") continue;
    const trimmed = markdown.trim();
    if (!trimmed) continue;
    list.push(trimmed);
  }

  return list;
};

const getSitemapUrls = async (seedUrl: string, count: number): Promise<string[]> => {
  const data = await postJson<SitemapResponse>(`${CRAWLER_BASE_URL}/sitemap`, {
    url: seedUrl,
    max_urls: Math.max(50, count * 10),
  }, 120_000);

  const rawUrls = Array.isArray(data.urls) ? data.urls : [];
  const out: string[] = [];
  const seen = new Set<string>();

  for (const raw of rawUrls) {
    if (typeof raw !== "string") continue;
    try {
      const normalized = new URL(raw).toString();
      const key = canonicalKey(normalized);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(normalized);
      if (out.length >= count) break;
    } catch {
      // ignore invalid urls from sitemap
    }
  }

  return out;
};

const runSequential = async (urls: string[]): Promise<RunMetrics> => {
  const startedAt = performance.now();
  let crawlMs = 0;
  let embedMs = 0;
  let pagesEmbedded = 0;

  for (const url of urls) {
    const crawlStart = performance.now();
    const crawlData = await postJson<CrawlResponse>(`${CRAWLER_BASE_URL}/crawl`, {
      scope: "single_page",
      url,
      max_urls: 1,
    });
    crawlMs += performance.now() - crawlStart;

    const markdowns = toMarkdownList(crawlData.results);
    if (!markdowns.length) continue;

    const embedStart = performance.now();
    const vectors = await embed([markdowns[0]]);
    embedMs += performance.now() - embedStart;

    if (!vectors.length) {
      throw new Error(`Embedding response was empty for URL: ${url}`);
    }

    pagesEmbedded += 1;
  }

  return {
    totalMs: performance.now() - startedAt,
    crawlMs,
    embedMs,
    pagesEmbedded,
  };
};

const runBatch = async (urls: string[]): Promise<RunMetrics> => {
  const startedAt = performance.now();

  const crawlStart = performance.now();
  const crawlData = await postJson<CrawlResponse>(`${CRAWLER_BASE_URL}/crawl`, {
    scope: "single_page",
    urls,
    max_urls: urls.length,
  }, 300_000);
  const crawlMs = performance.now() - crawlStart;

  const markdowns = toMarkdownList(crawlData.results);
  if (!markdowns.length) {
    throw new Error("Batch crawl produced no markdown pages.");
  }

  const embedStart = performance.now();
  const vectors = await embed(markdowns);
  const embedMs = performance.now() - embedStart;

  if (vectors.length !== markdowns.length) {
    throw new Error(`Batch embedding mismatch: expected ${markdowns.length}, got ${vectors.length}`);
  }

  return {
    totalMs: performance.now() - startedAt,
    crawlMs,
    embedMs,
    pagesEmbedded: markdowns.length,
  };
};

const avg = (values: number[]): number => values.reduce((sum, item) => sum + item, 0) / Math.max(values.length, 1);

const printRun = (label: string, run: number, metrics: RunMetrics) => {
  console.log(
    `${label} run ${run}: total=${(metrics.totalMs / 1000).toFixed(2)}s ` +
    `(crawl=${(metrics.crawlMs / 1000).toFixed(2)}s, embed=${(metrics.embedMs / 1000).toFixed(2)}s, pages=${metrics.pagesEmbedded})`
  );
};

async function main() {
  if (!Number.isInteger(PAGE_COUNT) || PAGE_COUNT <= 0) {
    throw new Error(`PAGE_COUNT must be positive integer, got: ${PAGE_COUNT}`);
  }

  if (!Number.isInteger(REPEATS) || REPEATS <= 0) {
    throw new Error(`REPEATS must be positive integer, got: ${REPEATS}`);
  }

  console.log(`Crawler base: ${CRAWLER_BASE_URL}`);
  console.log(`Embedding base: ${EMBEDDING_BASE_URL}`);
  console.log(`Seed sitemap: ${SITEMAP_SEED_URL}`);

  const urls = await getSitemapUrls(SITEMAP_SEED_URL, PAGE_COUNT);
  if (urls.length < PAGE_COUNT) {
    throw new Error(`Expected ${PAGE_COUNT} URLs from sitemap, got ${urls.length}.`);
  }

  console.log("Selected URLs:");
  urls.forEach((url, index) => console.log(`${index + 1}. ${url}`));

  const sequentialRuns: RunMetrics[] = [];
  const batchRuns: RunMetrics[] = [];

  for (let run = 1; run <= REPEATS; run += 1) {
    // Alternate order for fairness/caching effects.
    const runSequentialFirst = run % 2 === 1;

    if (runSequentialFirst) {
      const seq = await runSequential(urls);
      sequentialRuns.push(seq);
      printRun("Sequential", run, seq);

      const bat = await runBatch(urls);
      batchRuns.push(bat);
      printRun("Batch", run, bat);
    } else {
      const bat = await runBatch(urls);
      batchRuns.push(bat);
      printRun("Batch", run, bat);

      const seq = await runSequential(urls);
      sequentialRuns.push(seq);
      printRun("Sequential", run, seq);
    }
  }

  const seqAvgTotal = avg(sequentialRuns.map((r) => r.totalMs));
  const batchAvgTotal = avg(batchRuns.map((r) => r.totalMs));
  const speedup = seqAvgTotal / Math.max(batchAvgTotal, 1);

  console.log("\n=== Summary ===");
  console.log(`Sequential avg total: ${(seqAvgTotal / 1000).toFixed(2)}s`);
  console.log(`Batch avg total: ${(batchAvgTotal / 1000).toFixed(2)}s`);
  console.log(`Relative speedup (sequential/batch): ${speedup.toFixed(2)}x`);

  console.log(`Sequential avg crawl: ${(avg(sequentialRuns.map((r) => r.crawlMs)) / 1000).toFixed(2)}s`);
  console.log(`Sequential avg embed: ${(avg(sequentialRuns.map((r) => r.embedMs)) / 1000).toFixed(2)}s`);
  console.log(`Batch avg crawl: ${(avg(batchRuns.map((r) => r.crawlMs)) / 1000).toFixed(2)}s`);
  console.log(`Batch avg embed: ${(avg(batchRuns.map((r) => r.embedMs)) / 1000).toFixed(2)}s`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error("test-crawler-speed failed:", error);
    process.exit(1);
  });
}
