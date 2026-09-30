import consoleApp from "../public/index.html";
import { ApiKeyRecord } from "./auth.js";
import { requireAuth } from "./auth_scope.js";
import { config, logger } from "./config.js";
import { initDB } from "./db.js";
import {
  deleteDocumentHandler,
  ingestHandler,
  ingestStatusHandler,
  recalculateAllEmbeddingsHandler,
  recalculateEmbeddingsHandler,
  updateContentHandler,
  updateMetadataHandler,
} from "./handlers/document_handlers.js";
import {
  addOrganizationHandler,
  addProjectHandler,
  checkKeyHandler,
  deleteKeyHandler,
  deleteOrganizationHandler,
  deleteProjectHandler,
  disableKeyHandler,
  enableKeyHandler,
  issueKeyHandler,
  listKeysHandler,
  listOrganizationsHandler,
  listProjectsHandler,
  listRoutesHandler,
  updateProjectHandler,
} from "./handlers/admin.js";
import {
  getToolsHandler,
  listDocumentsHandler,
  listProjectsToolHandler,
  mcpHandler,
  searchDocumentsHandler,
} from "./handlers/tools.js";
import { extractMarkdownHandler } from "./handlers/convert_handlers.js";
import { jsonResponse, parseJsonBody, withCors } from "./http.js";
import { z } from "zod";
import { buildOpenApiSpec, RouteMeta } from "./openapi.js";
import { createCrawlerTables, startCrawlerScheduler } from "./crawler/domain_crawl.js";
import {
  crawlAdminHandler,
  crawlerStatusAdminHandler,
  deleteCrawlerAdminHandler,
  listCrawlersAdminHandler,
  stopCrawlerAdminHandler,
} from "./handlers/crawler_handlers.js";

import {
  addOrganizationBodySchema,
  addProjectBodySchema,
  anyBodySchema,
  deleteOrganizationBodySchema,
  deleteProjectBodySchema,
  documentIdBodySchema,
  extractMarkdownBodySchema,
  ingestBodySchema,
  issueKeyBodySchema,
  keyActionBodySchema,
  listDocumentsBodySchema,
  listProjectsBodySchema,
  searchDocumentsBodySchema,
  updateContentBodySchema,
  updateMetadataBodySchema,
  updateProjectBodySchema,
  adminCrawlerCreateBodySchema,
  adminCrawlerDeleteBodySchema,
  adminCrawlerListBodySchema,
  adminCrawlerStopBodySchema,
} from "./schema.js";

type RouteContext = { url: URL; auth: any; body: any };
type RouteHandler = (req: Request, ctx: RouteContext) => Promise<Response> | Response;

const markdownResponseSchema = z.object({ markdown: z.string() }).strict();

const openApiHandler: RouteHandler = (req) => jsonResponse(buildOpenApiSpec(routes, new URL(req.url).origin));

const listRoutesAdapter: RouteHandler = (req, ctx) =>
  listRoutesHandler(req, { auth: ctx.auth as ApiKeyRecord }, routes);

const routes = new Map<string, RouteMeta>([
  [
    "GET /openapi.json",
    {
      handler: openApiHandler,
      privilege: -1,
      parseJson: false,
      openapi: { operationId: "getOpenApi", summary: "Get OpenAPI 3.2 specification", tags: ["meta"] },
    },
  ],
  [
    "GET /api/tools",
    {
      handler: getToolsHandler,
      privilege: config.privilege.user,
      parseJson: false,
      openapi: { operationId: "getTools", summary: "List available MCP tools", tags: ["tools"] },
    },
  ],
  [
    "POST /api/tools/list-documents",
    {
      handler: listDocumentsHandler,
      privilege: config.privilege.user,
      parseJson: true,
      openapi: {
        operationId: "listDocuments",
        summary: "List accessible documents",
        tags: ["tools"],
        requestBody: { required: false, schema: listDocumentsBodySchema },
      },
    },
  ],
  [
    "POST /api/tools/list-projects",
    {
      handler: listProjectsToolHandler,
      privilege: config.privilege.user,
      parseJson: true,
      openapi: {
        operationId: "listProjectsTool",
        summary: "List accessible projects",
        tags: ["tools"],
        requestBody: { required: false, schema: listProjectsBodySchema },
      },
    },
  ],
  [
    "POST /api/tools/search-documents",
    {
      handler: searchDocumentsHandler,
      privilege: config.privilege.user,
      parseJson: true,
      openapi: {
        operationId: "searchDocuments",
        summary: "Search document chunks",
        tags: ["tools"],
        requestBody: { required: true, schema: searchDocumentsBodySchema },
      },
    },
  ],
  [
    "POST /documents/ingest",
    {
      handler: ingestHandler,
      privilege: config.privilege.editor,
      parseJson: true,
      openapi: {
        operationId: "ingestDocument",
        summary: "Ingest document and build embeddings",
        tags: ["documents"],
        requestBody: { required: true, schema: ingestBodySchema },
      },
    },
  ],
  [
    "GET /documents/ingest-status",
    {
      handler: ingestStatusHandler,
      privilege: config.privilege.editor,
      parseJson: false,
      openapi: { operationId: "ingestStatus", summary: "Get ingest job status", tags: ["documents"] },
    },
  ],
  [
    "POST /documents/recalculate-all-embeddings",
    {
      handler: recalculateAllEmbeddingsHandler,
      privilege: config.privilege.admin,
      parseJson: false,
      openapi: {
        operationId: "recalculateAllEmbeddings",
        summary: "Recalculate embeddings for all accessible documents",
        tags: ["documents"],
      },
    },
  ],
  [
    "POST /documents/recalculate-embeddings",
    {
      handler: recalculateEmbeddingsHandler,
      privilege: config.privilege.editor,
      parseJson: true,
      openapi: {
        operationId: "recalculateEmbeddings",
        summary: "Recalculate embeddings for one document",
        tags: ["documents"],
        requestBody: { required: true, schema: documentIdBodySchema },
      },
    },
  ],
  [
    "POST /documents/update",
    {
      handler: updateMetadataHandler,
      privilege: config.privilege.editor,
      parseJson: true,
      openapi: {
        operationId: "updateDocumentMetadata",
        summary: "Update document metadata",
        tags: ["documents"],
        requestBody: { required: true, schema: updateMetadataBodySchema },
      },
    },
  ],
  [
    "POST /documents/update-content",
    {
      handler: updateContentHandler,
      privilege: config.privilege.editor,
      parseJson: true,
      openapi: {
        operationId: "updateDocumentContent",
        summary: "Update document content and recalculate embeddings",
        tags: ["documents"],
        requestBody: { required: true, schema: updateContentBodySchema },
      },
    },
  ],
  [
    "POST /documents/delete",
    {
      handler: deleteDocumentHandler,
      privilege: config.privilege.editor,
      parseJson: true,
      openapi: {
        operationId: "deleteDocument",
        summary: "Delete document",
        tags: ["documents"],
        requestBody: { required: true, schema: documentIdBodySchema },
      },
    },
  ],
  [
    "POST /extract-markdown",
    {
      handler: extractMarkdownHandler,
      privilege: config.privilege.editor,
      parseJson: false,
      openapi: {
        operationId: "extractMarkdown",
        summary: "Extract markdown from uploaded PDF",
        tags: ["documents"],
        requestBody: { required: true, contentType: "multipart/form-data", schema: extractMarkdownBodySchema },
        responses: {
          "200": {
            description: "Markdown extraction result",
            schema: markdownResponseSchema,
          },
          "415": { description: "Unsupported Media Type" },
        },
      },
    },
  ],
  [
    "POST /admin/check-key",
    {
      handler: checkKeyHandler,
      privilege: config.privilege.user,
      parseJson: false,
      openapi: { operationId: "checkKey", summary: "Check current API key", tags: ["admin"] },
    },
  ],
  [
    "POST /admin/issue-key",
    {
      handler: issueKeyHandler,
      privilege: config.privilege.projectadmin,
      parseJson: true,
      openapi: {
        operationId: "issueKey",
        summary: "Issue new API key",
        tags: ["admin"],
        requestBody: { required: true, schema: issueKeyBodySchema },
      },
    },
  ],
  [
    "POST /admin/delete-key",
    {
      handler: deleteKeyHandler,
      privilege: config.privilege.projectadmin,
      parseJson: true,
      openapi: {
        operationId: "deleteKey",
        summary: "Delete API key",
        tags: ["admin"],
        requestBody: { required: true, schema: keyActionBodySchema },
      },
    },
  ],
  [
    "POST /admin/keys",
    {
      handler: listKeysHandler,
      privilege: config.privilege.projectadmin,
      parseJson: true,
      openapi: {
        operationId: "listKeys",
        summary: "List API keys",
        tags: ["admin"],
        requestBody: { required: false, schema: anyBodySchema },
      },
    },
  ],
  [
    "POST /admin/disable-key",
    {
      handler: disableKeyHandler,
      privilege: config.privilege.admin,
      parseJson: true,
      openapi: {
        operationId: "disableKey",
        summary: "Disable API key",
        tags: ["admin"],
        requestBody: { required: true, schema: keyActionBodySchema },
      },
    },
  ],
  [
    "POST /admin/enable-key",
    {
      handler: enableKeyHandler,
      privilege: config.privilege.admin,
      parseJson: true,
      openapi: {
        operationId: "enableKey",
        summary: "Enable API key",
        tags: ["admin"],
        requestBody: { required: true, schema: keyActionBodySchema },
      },
    },
  ],
  [
    "POST /admin/routes",
    {
      handler: listRoutesAdapter,
      privilege: config.privilege.user,
      parseJson: false,
      openapi: { operationId: "listRoutes", summary: "List accessible routes", tags: ["admin"] },
    },
  ],
  [
    "POST /admin/organizations",
    {
      handler: listOrganizationsHandler,
      privilege: config.privilege.user,
      parseJson: false,
      openapi: { operationId: "listOrganizations", summary: "List organizations", tags: ["admin"] },
    },
  ],
  [
    "POST /admin/projects",
    {
      handler: listProjectsHandler,
      privilege: config.privilege.user,
      parseJson: true,
      openapi: {
        operationId: "listProjects",
        summary: "List projects",
        tags: ["admin"],
        requestBody: { required: false, schema: listProjectsBodySchema },
      },
    },
  ],
  [
    "POST /admin/add-project",
    {
      handler: addProjectHandler,
      privilege: config.privilege.admin,
      parseJson: true,
      openapi: {
        operationId: "addProject",
        summary: "Add project",
        tags: ["admin"],
        requestBody: { required: true, schema: addProjectBodySchema },
      },
    },
  ],
  [
    "POST /admin/update-project",
    {
      handler: updateProjectHandler,
      privilege: config.privilege.admin,
      parseJson: true,
      openapi: {
        operationId: "updateProject",
        summary: "Update project",
        tags: ["admin"],
        requestBody: { required: true, schema: updateProjectBodySchema },
      },
    },
  ],
  [
    "POST /admin/delete-project",
    {
      handler: deleteProjectHandler,
      privilege: config.privilege.admin,
      parseJson: true,
      openapi: {
        operationId: "deleteProject",
        summary: "Delete project",
        tags: ["admin"],
        requestBody: { required: true, schema: deleteProjectBodySchema },
      },
    },
  ],
  [
    "POST /admin/add-organization",
    {
      handler: addOrganizationHandler,
      privilege: config.privilege.superadmin,
      parseJson: true,
      openapi: {
        operationId: "addOrganization",
        summary: "Add organization",
        tags: ["admin"],
        requestBody: { required: true, schema: addOrganizationBodySchema },
      },
    },
  ],
  [
    "POST /admin/delete-organization",
    {
      handler: deleteOrganizationHandler,
      privilege: config.privilege.superadmin,
      parseJson: true,
      openapi: {
        operationId: "deleteOrganization",
        summary: "Delete organization",
        tags: ["admin"],
        requestBody: { required: true, schema: deleteOrganizationBodySchema },
      },
    },
  ],
  [
    "POST /admin/crawl",
    {
      handler: crawlAdminHandler,
      privilege: config.privilege.admin,
      parseJson: true,
      openapi: {
        operationId: "adminCrawl",
        summary: "Create or run web crawler",
        tags: ["crawler"],
        requestBody: { required: true, schema: adminCrawlerCreateBodySchema },
      },
    },
  ],
  [
    "POST /admin/list-crawlers",
    {
      handler: listCrawlersAdminHandler,
      privilege: config.privilege.admin,
      parseJson: true,
      openapi: {
        operationId: "adminListCrawlers",
        summary: "List crawler configurations",
        tags: ["crawler"],
        requestBody: { required: true, schema: adminCrawlerListBodySchema },
      },
    },
  ],
  [
    "POST /admin/delete-crawler",
    {
      handler: deleteCrawlerAdminHandler,
      privilege: config.privilege.admin,
      parseJson: true,
      openapi: {
        operationId: "adminDeleteCrawler",
        summary: "Delete crawler configuration",
        tags: ["crawler"],
        requestBody: { required: true, schema: adminCrawlerDeleteBodySchema },
      },
    },
  ],
  [
    "GET /admin/crawler-status",
    {
      handler: crawlerStatusAdminHandler,
      privilege: config.privilege.admin,
      parseJson: false,
      openapi: {
        operationId: "adminCrawlerStatus",
        summary: "Get crawler run status",
        tags: ["crawler"],
      },
    },
  ],
  [
    "POST /admin/stop-crawler",
    {
      handler: stopCrawlerAdminHandler,
      privilege: config.privilege.admin,
      parseJson: true,
      openapi: {
        operationId: "adminStopCrawler",
        summary: "Stop currently running crawler job",
        tags: ["crawler"],
        requestBody: { required: true, schema: adminCrawlerStopBodySchema },
      },
    },
  ],
  [
    "GET /mcp",
    {
      handler: mcpHandler,
      privilege: config.privilege.user,
      parseJson: false,
      openapi: { operationId: "mcpGet", summary: "MCP Streamable HTTP endpoint (GET)", tags: ["mcp"] },
    },
  ],
  [
    "POST /mcp",
    {
      handler: mcpHandler,
      privilege: config.privilege.user,
      parseJson: false,
      openapi: { operationId: "mcpPost", summary: "MCP Streamable HTTP endpoint (POST)", tags: ["mcp"] },
    },
  ],
  [
    "DELETE /mcp",
    {
      handler: mcpHandler,
      privilege: config.privilege.user,
      parseJson: false,
      openapi: { operationId: "mcpDelete", summary: "MCP Streamable HTTP endpoint (DELETE)", tags: ["mcp"] },
    },
  ],
]);

async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname.startsWith("/console/") && url.pathname !== "/console/") {
    const relativePath = url.pathname.slice("/console/".length);
    if (!relativePath.includes("..")) {
      const file = Bun.file(new URL(`../public/${relativePath}`, import.meta.url));
      if (await file.exists()) {
        return new Response(file);
      }
    }
  }

  const key = `${request.method} ${url.pathname}`;

  if (request.method === "OPTIONS") {
    return new Response(null, withCors({ status: 204 }));
  }


  const route = routes.get(key);
  if (!route) {
    return jsonResponse({ error: "Not found" }, 404);
  }

  let auth: any = null;
  if (route.privilege >= 0) {
    const authResult = await requireAuth(request, route.privilege);
    if ("response" in authResult) {
      return authResult.response;
    }
    auth = authResult;
  }

  let body: any;
  if (route.parseJson) {
    const bodyResult = await parseJsonBody(request);
    if ("response" in bodyResult) {
      return bodyResult.response;
    }
    body = bodyResult;
  }

  return route.handler(request, { url, auth, body });
}

async function main() {
  try {
    if (!config.DB_TABLE_METADATA || !config.DB_TABLE_CHUNKS) {
      throw new Error("DB_TABLE_METADATA and DB_TABLE_CHUNKS must be set");
    }

    await initDB();
    await createCrawlerTables();
    startCrawlerScheduler();
    logger.info("Database initialized");

    const server = Bun.serve({
      port: Number(config.BUN_PORT),
      hostname: config.BUN_HOST,
      routes: {
        "/console": Response.redirect("/console/", 308),
        "/console/": consoleApp,
      },
      fetch: handleRequest,
    });

    const baseUrl = `http://${config.BUN_HOST}:${server.port}`;
    logger.info({ port: server.port }, "OpenAI Function-Calling API started");
    logger.info("----------Browser entry point------------");
    logger.info(`GET  ${baseUrl} - Admin panel (static HTML for managment)`);
    logger.info(`GET  ${baseUrl}/openapi.json - OpenAPI 3.2 spec`);
  } catch (error) {
    logger.error({ err: error }, "Server error");
    process.exit(1);
  }
}

main();

