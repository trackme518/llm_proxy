import { z } from "zod";

const intFromUnknown = z.coerce.number().int();
const optionalPositiveInt = intFromUnknown.refine((v) => v > 0).optional();
const optionalCrawlerMaxPages = intFromUnknown.refine((v) => v > 0 && v <= 2000).optional();
const optionalNonNegativeIntArray = z
  .array(intFromUnknown)
  .optional()
  .transform((arr) => (arr ?? []).filter((id) => Number.isInteger(id) && id >= 0));

export const anyBodySchema = z.object({}).passthrough();

export const listDocumentsBodySchema = z
  .object({
    project_id: optionalPositiveInt,
    project_ids: z.array(intFromUnknown.refine(v => v > 0)).optional(),
    organization_id: optionalPositiveInt,
  })
  .strict()
  .partial();

export const searchDocumentsBodySchema = z
  .object({
    query: z.string().trim().min(1, "query is required"),
    document_ids: optionalNonNegativeIntArray,
    project_id: optionalPositiveInt,
    project_ids: z.array(intFromUnknown.refine(v => v > 0)).optional(),
  })
  .strict();

export const ingestBodySchema = z
  .object({
    title: z.string().trim().min(1, "title is required"),
    content: z.string().trim().min(1, "content is required"),
    project_id: optionalPositiveInt,
    project_ids: z.array(intFromUnknown.refine(v => v > 0)).min(1).optional(),
    organization_id: optionalPositiveInt,
    author: z.string().optional(),
    summary: z.string().optional(),
    keywords: z.array(z.string()).optional(),
    domain: z.string().optional(),
    date_published: z.string().optional(),
    language: z.string().optional(),
    chunking_strategy: z.enum(["semantic", "fixed"]).optional(),
    chunk_max_chars: intFromUnknown.optional(),
    chunk_overlap_chars: intFromUnknown.optional(),
  })
  .passthrough();

export const documentIdBodySchema = z.object({ document_id: intFromUnknown.refine((v) => v > 0) }).strict();

export const extractMarkdownBodySchema = z.object({ file: z.string().min(1) }).strict();

export const updateContentBodySchema = z
  .object({
    document_id: intFromUnknown.refine((v) => v > 0, "document_id is required"),
    content: z.string().trim().min(1, "content is required"),
  })
  .strict();

export const updateMetadataBodySchema = z
  .object({
    document_id: intFromUnknown.refine((v) => v > 0, "document_id is required"),
    project_ids: z.array(intFromUnknown.refine(v => v > 0)).min(1).optional(),
    title: z.string().optional(),
    author: z.string().optional(),
    summary: z.string().optional(),
    content: z.string().optional(),
    chunking_strategy: z.string().optional(),
    chunk_max_chars: intFromUnknown.optional(),
    chunk_overlap_chars: intFromUnknown.optional(),
    keywords: z.array(z.string()).optional(),
    domain: z.string().optional(),
    date_published: z.string().optional(),
    language: z.string().optional(),
    content_hash: z.string().optional(),
  })
  .strict();

export const mcpSearchDocumentsArgsSchema = z
  .object({
    query: z.string().trim().min(1, "query is required"),
    document_ids: optionalNonNegativeIntArray,
    project_ids: z.array(intFromUnknown.refine((v) => v > 0)).optional(),
  })
  .strict();

export const issueKeyBodySchema = z
  .object({
    username: z.string().trim().min(1, "username is required"),
    privilege_level: intFromUnknown.optional(),
    valid_until_unix: intFromUnknown.optional(),
    organization_id: optionalPositiveInt,
    project_ids: z.array(intFromUnknown.refine((v) => v > 0)).optional(),
  })
  .strict();

export const keyActionBodySchema = z
  .object({
    key_id: z.string().trim().min(1, "key_id is required"),
  })
  .strict();

export const addOrganizationBodySchema = z
  .object({
    slug: z.string().trim().min(1, "slug is required"),
    name: z.string().trim().min(1, "name is required"),
  })
  .strict();

export const addProjectBodySchema = z
  .object({
    slug: z.string().trim().min(1, "slug is required").optional(),
    name: z.string().trim().min(1, "name is required"),
    description: z.string().optional(),
    organization_id: optionalPositiveInt,
  })
  .strict();

export const updateProjectBodySchema = z
  .object({
    project_id: intFromUnknown.refine((v) => v > 0, "project_id must be a positive integer"),
    name: z.string().trim().min(1, "name is required").optional(),
    description: z.string().optional(),
  })
  .strict();

export const deleteProjectBodySchema = z
  .object({
    project_id: intFromUnknown.refine((v) => v > 0, "project_id must be a positive integer"),
  })
  .strict();

export const deleteOrganizationBodySchema = z
  .object({
    organization_id: intFromUnknown.refine((v) => v > 0, "organization_id must be a positive integer"),
  })
  .strict();

export const listProjectsBodySchema = z
  .object({
    organization_id: optionalPositiveInt,
  })
  .strict()
  .partial();

export const adminCrawlerCreateBodySchema = z
  .object({
    organization_id: intFromUnknown.refine((v) => v > 0, "organization_id is required"),
    url: z.string().trim().url("url must be a valid URL").optional(),
    scope: z.enum(["single_page", "whole_domain"]).optional(),
    run_now: z.boolean().optional(),
    use_sitemap: z.boolean().optional(),
    max_pages: optionalCrawlerMaxPages,
    use_llm_description: z.boolean().optional(),
    use_cron: z.boolean().optional(),
    cron_interval_minutes: optionalPositiveInt,
    cron_start_time: z.string().optional(),
    crawler_id: optionalPositiveInt,
  })
  .strict();

export const adminCrawlerListBodySchema = z
  .object({
    organization_id: intFromUnknown.refine((v) => v > 0, "organization_id is required"),
  })
  .strict();

export const adminCrawlerDeleteBodySchema = z
  .object({
    organization_id: intFromUnknown.refine((v) => v > 0, "organization_id is required"),
    crawler_id: intFromUnknown.refine((v) => v > 0, "crawler_id is required"),
  })
  .strict();

export const adminCrawlerStopBodySchema = z
  .object({
    organization_id: intFromUnknown.refine((v) => v > 0, "organization_id is required"),
  })
  .strict();

export type SearchDocumentsBody = z.infer<typeof searchDocumentsBodySchema>;
export type McpSearchDocumentsArgs = z.infer<typeof mcpSearchDocumentsArgsSchema>;
export type IssueKeyBody = z.infer<typeof issueKeyBodySchema>;
export type AdminCrawlerCreateBody = z.infer<typeof adminCrawlerCreateBodySchema>;
export type AdminCrawlerListBody = z.infer<typeof adminCrawlerListBodySchema>;
export type AdminCrawlerDeleteBody = z.infer<typeof adminCrawlerDeleteBodySchema>;
export type AdminCrawlerStopBody = z.infer<typeof adminCrawlerStopBodySchema>;
