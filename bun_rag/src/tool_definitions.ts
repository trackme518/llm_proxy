const mcpToolInputSchemas = {
  list_projects: {
    type: "object" as const,
    properties: {},
    required: [],
  },
  search_documents: {
    type: "object" as const,
    properties: {
      query: {
        type: "string",
        description: "Construct a well-formed search query optimized for document retrieval.",
      },
      // Future option (kept for reference): allow second-level filtering by specific document IDs.
      // document_ids: {
      //   type: "array",
      //   items: {
      //     type: "number",
      //   },
      //   description: "Optional list of document IDs within the selected projects.",
      // },
      project_ids: {
        type: "array",
        items: {
          type: "number",
        },
        description: "Optional list of project IDs to constrain search scope.",
      },
    },
    required: ["query"],
  },
};

export const toolInputSchemas = mcpToolInputSchemas;

const tools = {
  list_projects: {
    name: "list_projects",
    description: "List all accessible projects with project_id, title, description, and document_count.",
    parameters: mcpToolInputSchemas.list_projects,
  },
  search_documents: {
    name: "search_documents",
    //description: "Search documents. Optionally restrict scope with project_ids.",
    description: "Search documents. Optionally, call list_projects first and pass project_ids to constrain scope for more focused search. If no project_ids are provided, search runs across all avaliable documents.",
    parameters: mcpToolInputSchemas.search_documents,
  },
};

export const toolDefinitions = Object.values(tools).map((tool) => ({
  type: "function",
  function: tool,
}));

export const mcpTools = Object.values(tools).map((tool) => ({
  name: tool.name,
  description: tool.description,
  inputSchema: tool.parameters,
}));
