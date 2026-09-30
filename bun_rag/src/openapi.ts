import { z, ZodTypeAny } from "zod";

export type JsonSchema = Record<string, any>;

type OpenApiResponseMeta = { description: string; schema?: ZodTypeAny | JsonSchema };

export type RouteOpenApiMeta = {
  operationId: string;
  summary: string;
  tags: string[];
  requestBody?: {
    required?: boolean;
    contentType?: string;
    schema: ZodTypeAny | JsonSchema;
  };
  response?: { description?: string; schema?: ZodTypeAny | JsonSchema };
  responses?: Record<string, OpenApiResponseMeta>;
};

export type RouteMeta = {
  handler: (req: Request, ctx: { url: URL; auth: any; body: any }) => Promise<Response> | Response;
  privilege: number;
  parseJson: boolean;
  openapi?: RouteOpenApiMeta;
};

const errorSchema = { type: "object", additionalProperties: true, properties: { error: { type: "string" } } };
const okSchema = { type: "object", additionalProperties: true };

const isZodSchema = (schema: unknown): schema is ZodTypeAny => !!schema && typeof schema === "object" && "safeParse" in (schema as any);
const stripJsonSchemaMeta = (schema: JsonSchema): JsonSchema => {
  const { $schema, ...rest } = schema;
  return rest;
};
const toOpenApiSchema = (schema?: ZodTypeAny | JsonSchema): JsonSchema => {
  if (!schema) return okSchema;
  if (isZodSchema(schema)) {
    try {
      return stripJsonSchemaMeta(z.toJSONSchema(schema as any, { unrepresentable: "any" }) as JsonSchema);
    } catch {
      return okSchema;
    }
  }
  return schema;
};

export const buildOpenApiSpec = (routes: Map<string, RouteMeta>, serverUrl: string) => {
  const paths: Record<string, any> = {};

  for (const [routeKey, meta] of routes.entries()) {
    if (!meta.openapi) continue;
    const firstSpace = routeKey.indexOf(" ");
    const method = routeKey.slice(0, firstSpace).toLowerCase();
    const path = routeKey.slice(firstSpace + 1);

    paths[path] ??= {};

    const operation: Record<string, any> = {
      operationId: meta.openapi.operationId,
      summary: meta.openapi.summary,
      tags: meta.openapi.tags,
      responses: {
        "200": {
          description: meta.openapi.response?.description ?? "Success",
          content: { "application/json": { schema: toOpenApiSchema(meta.openapi.response?.schema) } },
        },
        "400": { description: "Bad Request", content: { "application/json": { schema: errorSchema } } },
        "401": { description: "Unauthorized", content: { "application/json": { schema: errorSchema } } },
        "403": { description: "Forbidden", content: { "application/json": { schema: errorSchema } } },
        "500": { description: "Internal Server Error", content: { "application/json": { schema: errorSchema } } },
      },
    };

    if (meta.privilege >= 0) operation.security = [{ bearerAuth: [] }];

    if (meta.openapi.requestBody) {
      const contentType = meta.openapi.requestBody.contentType ?? "application/json";
      operation.requestBody = {
        required: meta.openapi.requestBody.required ?? true,
        content: { [contentType]: { schema: toOpenApiSchema(meta.openapi.requestBody.schema) } },
      };
    }

    if (meta.openapi.responses) {
      const customResponses = Object.fromEntries(
        Object.entries(meta.openapi.responses).map(([status, responseMeta]) => [
          status,
          {
            description: responseMeta.description,
            content: { "application/json": { schema: toOpenApiSchema(responseMeta.schema) } },
          },
        ])
      );
      operation.responses = { ...operation.responses, ...customResponses };
    }

    paths[path][method] = operation;
  }

  return {
    openapi: "3.2.0",
    info: {
      title: "bun_rag API",
      version: "1.0.0",
      description: "REST API and MCP bridge for document ingestion and retrieval.",
    },
    servers: [{ url: serverUrl }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "API Key",
        },
      },
      schemas: { ErrorResponse: errorSchema },
    },
  };
};
