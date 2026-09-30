import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { ApiKeyRecord, listProjects } from "../auth.js";
import { authScope } from "../auth_scope.js";
import { logger } from "../config.js";
import { jsonResponse, withCorsResponse } from "../http.js";
import { createMcpServer } from "../mcp_server.js";
import { fetchDocuments, fetchProjects, searchDocuments } from "../search_service.js";
import { listDocumentsBodySchema, listProjectsBodySchema, searchDocumentsBodySchema } from "../schema.js";
import { toolDefinitions } from "../tool_definitions.js";

export async function getToolsHandler(req: Request): Promise<Response> {
  return jsonResponse({ tools: toolDefinitions });
}

export async function listDocumentsHandler(req: Request, ctx: { body: any; auth: ApiKeyRecord }): Promise<Response> {
  try {
    const parsed = listDocumentsBodySchema.safeParse(ctx.body ?? {});
    if (!parsed.success) {
      return jsonResponse({ error: parsed.error.issues[0]?.message || "Invalid request body" }, 400);
    }
    const requestedProjectIds = [...new Set(parsed.data.project_ids ?? (parsed.data.project_id ? [parsed.data.project_id] : []))];
    const requestedOrganizationId = Number(parsed.data.organization_id ?? 0);

    const scope = await authScope(ctx.auth);
    let organizationId = scope.organizationId;
    let projectIds = [...scope.projectIds];

    if (scope.globalScope && Number.isInteger(requestedOrganizationId) && requestedOrganizationId > 0) {
      organizationId = requestedOrganizationId;
      const allOrgProjects = await listProjects(requestedOrganizationId);
      projectIds = allOrgProjects.map((p: any) => Number(p.project_id));
    }

    if (requestedProjectIds.length) {
      const allowed = new Set(projectIds);
      if (!scope.globalScope && requestedProjectIds.some(id => !allowed.has(id))) {
        return jsonResponse({ error: "Requested project is outside your scope" }, 403);
      }
      projectIds = requestedProjectIds;
    }

    const documents = await fetchDocuments(organizationId, projectIds, scope.globalScope);
    return jsonResponse({ documents, success: true });
  } catch (error) {
    logger.error({ err: error }, "List documents error");
    return jsonResponse({ isError: true, error: `Failed to list documents: ${error}` }, 500);
  }
}

export async function listProjectsToolHandler(req: Request, ctx: { body: any; auth: ApiKeyRecord }): Promise<Response> {
  try {
    const parsed = listProjectsBodySchema.safeParse(ctx.body ?? {});
    if (!parsed.success) {
      return jsonResponse({ error: parsed.error.issues[0]?.message || "Invalid request body" }, 400);
    }

    const requestedOrganizationId = Number(parsed.data.organization_id ?? 0);
    const scope = await authScope(ctx.auth);
    let organizationId = scope.organizationId;
    let projectIds = [...scope.projectIds];

    if (scope.globalScope && Number.isInteger(requestedOrganizationId) && requestedOrganizationId > 0) {
      organizationId = requestedOrganizationId;
      const allOrgProjects = await listProjects(requestedOrganizationId);
      projectIds = allOrgProjects.map((p: any) => Number(p.project_id));
    }

    const projects = await fetchProjects(organizationId, projectIds, scope.globalScope);
    return jsonResponse({ projects, success: true });
  } catch (error) {
    logger.error({ err: error }, "List projects tool error");
    return jsonResponse({ isError: true, error: `Failed to list projects: ${error}` }, 500);
  }
}

export async function searchDocumentsHandler(req: Request, ctx: { body: any; auth: ApiKeyRecord }): Promise<Response> {
  try {
    const parsed = searchDocumentsBodySchema.safeParse(ctx.body ?? {});
    if (!parsed.success) {
      return jsonResponse({ error: parsed.error.issues[0]?.message || "Invalid request body" }, 400);
    }
    const { query, document_ids, project_id, project_ids } = parsed.data;

    const scope = await authScope(ctx.auth);
    let projectIds = [...scope.projectIds];
    const requestedProjectIds = [...new Set(project_ids ?? (project_id ? [project_id] : []))];
    if (requestedProjectIds.length) {
      if (!scope.globalScope && requestedProjectIds.some(id => !projectIds.includes(id))) {
        return jsonResponse({ error: "Requested project is outside your scope" }, 403);
      }
      projectIds = requestedProjectIds;
    }

    const searchResult = await searchDocuments(query, document_ids, projectIds, scope.organizationId, scope.globalScope);
    if (searchResult.error) {
      return jsonResponse({ isError: true, error: searchResult.error }, searchResult.status ?? 400);
    }

    if (!searchResult.citations || searchResult.citations.length === 0) {
      return jsonResponse({ citations: [], error: "No relevant chunks found in selected documents." });
    }

    return jsonResponse({ citations: searchResult.citations });
  } catch (error) {
    logger.error({ err: error }, "Search documents error");
    return jsonResponse({ isError: true, error: `Search failed: ${error}` }, 500);
  }
}

export async function mcpHandler(req: Request, ctx: { auth: ApiKeyRecord }): Promise<Response> {
  console.log("METHOD:", req.method);
  console.log("HEADERS:", Object.fromEntries(req.headers));

  try {
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const mcpServer = createMcpServer(ctx.auth);
    await mcpServer.connect(transport);
    const response = await transport.handleRequest(req);
    return withCorsResponse(response);
  } catch (error) {
    logger.error({ err: error }, "MCP response error");
    return jsonResponse({ error: "Failed to process MCP request" }, 500);
  }
}
