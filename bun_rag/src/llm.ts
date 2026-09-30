import { TextChunk } from "./chunking.js";
import { config } from "./config.js";

type MpcServerConfig = {
  serverLabel: string;
  serverUrl: string;
  authorization?: string;
  allowedTools?: string[];
  requireApproval?: "never" | "always";
};

//--------------------------------------------------------------------------------------
//Preprocess text using extrenal LLM to format into structured summary
// Then add this to original chunk to enhance it
export const summarizeChunks = async (chunks: TextChunk[]): Promise<TextChunk[]> => {
  //now process the chunks using external LLM to add additional fields
  const jsonSchema = {
    type: "object",
    properties: {
      summary: { type: "string" },
    },
    required: ["summary"],
    additionalProperties: false,
  };

  const enrichedChunks = await Promise.all(
    chunks.map(async (chunk) => {
      const prompt = [
        "You will receive a text chunk.",
        "Return ONLY valid JSON that matches this schema:",
        JSON.stringify(jsonSchema),
        "Field requirements:",
        "- summary: A brief summary of the chunk.",
        "Do not include markdown or extra text.",
        "Chunk:",
        chunk.text,
      ].join("\n");

      const result = await callResponses({
        prompt,
        structuredOutput: true,
        jsonSchema,
      });

      if (!result) {
        return chunk;
      }

      chunk.summary = result;
      return chunk;
    })
  );

  return enrichedChunks;
};

//call openai llm compatible endpoint with prompt and optional structured output
export const callResponses = async ({
  prompt,
  structuredOutput = false,
  jsonSchema,
  mcpServer,
  requestTimeoutMs,
}: {
  prompt: string;
  structuredOutput?: boolean;
  jsonSchema?: Record<string, unknown>;
  mcpServer?: MpcServerConfig;
  requestTimeoutMs?: number;
}): Promise<string | null> => {
  const endpoint = config.LLM_API_BASE;
  const apiKey = config.LLM_API_KEY;
  const model = config.LLM_MODEL;

  if (!apiKey || !endpoint || !model) {
    return null;
  }

  if (structuredOutput && !jsonSchema) {
    return null;
  }

  const body: Record<string, unknown> = {
    model,
    input: prompt,
    temperature: 0.2,
  };

  if (structuredOutput) {
    body.instructions = "You are a structured data generator.";
  }

  if (structuredOutput) {
    body.text = {
      format: {
        type: "json_schema",
        name: "chunk_metadata",
        schema: jsonSchema,
        strict: true,
      },
    };
  }

  if (mcpServer) {
    body.tools = [
      {
        type: "mcp",
        server_label: mcpServer.serverLabel,
        server_url: mcpServer.serverUrl,
        require_approval: mcpServer.requireApproval ?? "never",
        ...(mcpServer.authorization
          ? {
              headers: {
                Authorization: mcpServer.authorization,
              },
            }
          : {}),
        ...(mcpServer.allowedTools?.length
          ? {
              allowed_tools: mcpServer.allowedTools,
            }
          : {}),
      },
    ];
    body.tool_choice = "auto";
  }

  const timeoutMs = Math.max(1000, Number(requestTimeoutMs ?? config.LLM_REQUEST_TIMEOUT_MS ?? 60000));
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if ((error as any)?.name === "AbortError") {
      throw new Error(`LLM request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutHandle);
  }

  if (response.status !== 200) {
    const errorText = await response.text();
    throw new Error(`LLM request failed (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  const normalizeText = (value: unknown): string | null => {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  };

  const outputText = normalizeText(data?.output_text);
  if (outputText) {
    return outputText;
  }

  const outputItems = Array.isArray(data?.output) ? data.output : [];
  const candidates: string[] = [];

  for (const item of outputItems) {
    if (item?.type !== "message" || item?.role !== "assistant") {
      continue;
    }

    const contentItems = Array.isArray(item?.content) ? item.content : [];
    for (const content of contentItems) {
      if (content?.type !== "output_text") {
        continue;
      }
      const text = normalizeText(content?.text);
      if (text) {
        candidates.push(text);
      }
    }
  }

  if (candidates.length > 0) {
    return candidates[candidates.length - 1];
  }

  return null;
};
