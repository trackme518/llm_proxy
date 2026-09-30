import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, InitializeRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ApiKeyRecord, hasPrivilege } from "./auth.js";
import { authScope } from "./auth_scope.js";
import { config, logger } from "./config.js";
import { mcpTools } from "./tool_definitions.js";
import { mcpSearchDocumentsArgsSchema } from "./schema.js";
import { fetchProjects, searchDocuments, searchReturnHelper } from "./search_service.js";

const MCP_SERVER_NAME = "rag-mcp";
const MCP_SERVER_VERSION = "1.0.0";
// We actually support 2025-11-25 but it was downgraded to support LMStduio 0.4.11.
const MCP_PROTOCOL_VERSION = "2024-11-05";

export const createMcpServer = (apiKey: ApiKeyRecord) => {
  const mcpServer = new Server(
    {
      name: MCP_SERVER_NAME,
      version: MCP_SERVER_VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  mcpServer.onerror = (error: unknown) => {
    logger.error({ err: error }, "MCP server error");
  };

  mcpServer.setRequestHandler(InitializeRequestSchema, async (request: any) => {
    logger.debug({ params: request.params }, "Initialize request received");
    return {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: MCP_SERVER_NAME,
        version: MCP_SERVER_VERSION,
      },
    };
  });

  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
    logger.debug("ListTools request received");
    return { tools: mcpTools };
  });

  mcpServer.setRequestHandler(CallToolRequestSchema, async (request: any) => {
    logger.debug({ tool: request.params.name }, "CallTool request received");
    const { name, arguments: args } = request.params;

    if (name === "list_projects") {
      if (!hasPrivilege(apiKey, config.privilege.user)) {
        return {
          content: [{ type: "text", text: "Error: Insufficient privileges for list_projects" }],
          isError: true,
        };
      }

      const scope = await authScope(apiKey);
      const projects = await fetchProjects(scope.organizationId, scope.projectIds, scope.globalScope);
      const payload = { projects };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(payload),
          },
        ],
        structuredContent: payload,
      };
    }

    if (name === "search_documents") {
      if (!hasPrivilege(apiKey, config.privilege.user)) {
        return {
          content: [{ type: "text", text: "Error: Insufficient privileges for search_documents" }],
          isError: true,
        };
      }

      const parsed = mcpSearchDocumentsArgsSchema.safeParse(args ?? {});
      if (!parsed.success) {
        return {
          content: [{ type: "text", text: `Error: ${parsed.error.issues.map((i) => i.message).join("; ")}` }],
          isError: true,
        };
      }
      const { query, document_ids, project_ids } = parsed.data;

      const scope = await authScope(apiKey);
      let scopedProjectIds = [...scope.projectIds];

      if (Array.isArray(project_ids) && project_ids.length > 0) {
        const requested = Array.from(new Set(project_ids.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)));
        if (!scope.globalScope) {
          const allowed = new Set(scope.projectIds);
          const outsideScope = requested.filter((id) => !allowed.has(id));
          if (outsideScope.length > 0) {
            return {
              content: [{ type: "text", text: `Error: Requested project_ids are outside your scope: ${outsideScope.join(", ")}` }],
              isError: true,
            };
          }
        }
        scopedProjectIds = requested;
      }

      const searchResult = await searchDocuments(query, document_ids, scopedProjectIds, scope.organizationId, scope.globalScope);
      return searchReturnHelper(query, searchResult);
    }

    return {
      content: [{ type: "text", text: `Error: Unknown tool ${name}` }],
      isError: true,
    };
  });

  return mcpServer;
};
