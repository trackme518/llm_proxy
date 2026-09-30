/** One OpenAI-compatible protocol for local and external embedding servers. */
export function createEmbeddingClient(options: {
  url: string;
  model: string;
  apiKey?: string;
  timeoutMs: number;
  dimensions?: number;
}) {
  const endpoint = new URL(options.url);
  const model = options.model?.trim();
  if (!model) throw new Error("EMBEDDINGS_MODEL must specify the server's embedding model ID");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.apiKey?.trim()) headers.Authorization = `Bearer ${options.apiKey.trim()}`;

  async function request(url: URL, body?: unknown): Promise<any> {
    const response = await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`Embedding service HTTP ${response.status}: ${await response.text()}`);
    }
    return response.json();
  }

  return async (texts: string[]): Promise<number[][]> => {
    if (!texts.length) return [];
    const result = await request(endpoint, { model, input: texts, encoding_format: "float" });
    if (!Array.isArray(result?.data) || result.data.length !== texts.length) {
      throw new Error("Embedding response count does not match input count");
    }
    const ordered = [...result.data].sort((a, b) => a.index - b.index);
    const dimensions = options.dimensions || ordered[0]?.embedding?.length;
    return ordered.map((item, index) => {
      if (item.index !== index || !Array.isArray(item.embedding) || !dimensions ||
          item.embedding.length !== dimensions ||
          !item.embedding.every((value: unknown) => typeof value === "number" && Number.isFinite(value))) {
        throw new Error(`Invalid embedding response: indexes and finite vectors must match input order and dimensions (${dimensions})`);
      }
      return item.embedding as number[];
    });
  };
}
