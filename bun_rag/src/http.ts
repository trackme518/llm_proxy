import { config } from "./config.js";

export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Credentials": "true",
};

export const withCors = (init: ResponseInit = {}) => {
  const headers = new Headers(init.headers);
  for (const [key, value] of Object.entries(corsHeaders)) {
    headers.set(key, value);
  }
  return { ...init, headers };
};

export const withCorsResponse = (response: Response) => {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders)) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

export function jsonResponse(body: any, status: number = 200, headers?: HeadersInit) {
  const baseHeaders: HeadersInit = {
    "Content-Type": "application/json",
    ...(headers || {}),
  };
  return new Response(JSON.stringify(body), withCors({ status, headers: baseHeaders }));
}

export type JsonParseResult<T> = T | { response: Response };

export const parseJsonBody = async <T = any>(request: Request): Promise<JsonParseResult<T>> => {
  try {
    const buffer = await request.arrayBuffer();
    if (buffer.byteLength === 0) {
      return {} as T;
    }
    if (buffer.byteLength > config.MAX_JSON_BYTES) {
      return { response: jsonResponse({ error: "Payload too large" }, 413) };
    }
    const contentType = request.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      return { response: jsonResponse({ error: "Content-Type must be application/json" }, 415) };
    }
    const text = new TextDecoder().decode(buffer);
    return JSON.parse(text) as T;
  } catch (error) {
    return { response: jsonResponse({ error: `Invalid JSON: ${error}` }, 400) };
  }
};
