import { ApiKeyRecord, hasPrivilege } from "../auth.js";
import { config } from "../config.js";
import { jsonResponse } from "../http.js";
import {
  createOrUpdateCrawlerAndMaybeRun,
  deleteCrawlerConfig,
  getCrawlerStatus,
  listCrawlerConfigs,
  parseCronInterval,
  parseCronStartTime,
  parseCrawlerMaxPages,
  parseCrawlerUseLlmDescription,
  parseCrawlerUseSitemap,
  parseScope,
  runCrawlerNowForExisting,
  stopActiveCrawlerJob,
} from "../crawler/domain_crawl.js";

const resolveOrganizationIdForAdmin = (auth: ApiKeyRecord, requestedOrganizationId: number): number | null => {
  const orgId = Number(requestedOrganizationId || 0);
  if (!Number.isInteger(orgId) || orgId <= 0) return null;

  const isSuper = hasPrivilege(auth, config.privilege.superadmin) && auth.organization_id == null;
  if (isSuper) return orgId;

  const ownOrgId = Number(auth.organization_id || 0);
  if (!Number.isInteger(ownOrgId) || ownOrgId <= 0) return null;
  if (ownOrgId !== orgId) return null;
  return orgId;
};

export async function crawlAdminHandler(req: Request, ctx: { body: any; auth: ApiKeyRecord }): Promise<Response> {
  try {
    const organizationId = resolveOrganizationIdForAdmin(ctx.auth, Number(ctx.body?.organization_id));
    if (!organizationId) {
      return jsonResponse({ error: "organization_id is required and must be in your scope" }, 400);
    }

    const crawlerId = Number(ctx.body?.crawler_id || 0) || null;
    const runNow = Boolean(ctx.body?.run_now);
    const url = String(ctx.body?.url || "").trim();

    if (crawlerId && !url) {
      if (!runNow) {
        return jsonResponse({ error: "run_now=true is required when crawler_id is provided without url" }, 400);
      }
      const runResult = await runCrawlerNowForExisting(organizationId, crawlerId);
      if ("error" in runResult) {
        return jsonResponse({ error: runResult.error }, 409);
      }
      return jsonResponse({ success: true, ...runResult });
    }

    if (!url) {
      return jsonResponse({ error: "url is required" }, 400);
    }

    const scope = parseScope(ctx.body?.scope);
    const useSitemap = parseCrawlerUseSitemap(ctx.body?.use_sitemap);
    const maxPages = parseCrawlerMaxPages(ctx.body?.max_pages);
    const useLlmDescription = parseCrawlerUseLlmDescription(ctx.body?.use_llm_description);
    const useCron = Boolean(ctx.body?.use_cron);
    const cronIntervalMinutes = parseCronInterval(ctx.body?.cron_interval_minutes);
    const cronStartTime = parseCronStartTime(ctx.body?.cron_start_time ?? null);

    if (useCron && !cronIntervalMinutes) {
      return jsonResponse({ error: "cron_interval_minutes is required when use_cron=true" }, 400);
    }

    const result = await createOrUpdateCrawlerAndMaybeRun({
      organizationId,
      crawlerId,
      url,
      scope,
      useSitemap,
      maxPages,
      useLlmDescription,
      useCron,
      cronIntervalMinutes,
      cronStartTime,
      runNow,
    });

    if ("error" in result) {
      return jsonResponse({ error: result.error }, 409);
    }

    return jsonResponse({
      success: true,
      crawler: result.crawler,
      job_id: result.job_id,
    });
  } catch (error: any) {
    return jsonResponse({ error: error?.message || String(error) }, 500);
  }
}

export async function listCrawlersAdminHandler(req: Request, ctx: { body: any; auth: ApiKeyRecord }): Promise<Response> {
  try {
    const organizationId = resolveOrganizationIdForAdmin(ctx.auth, Number(ctx.body?.organization_id));
    if (!organizationId) {
      return jsonResponse({ error: "organization_id is required and must be in your scope" }, 400);
    }

    const crawlers = await listCrawlerConfigs(organizationId);
    return jsonResponse({ crawlers });
  } catch (error: any) {
    return jsonResponse({ error: error?.message || String(error) }, 500);
  }
}

export async function deleteCrawlerAdminHandler(req: Request, ctx: { body: any; auth: ApiKeyRecord }): Promise<Response> {
  try {
    const organizationId = resolveOrganizationIdForAdmin(ctx.auth, Number(ctx.body?.organization_id));
    if (!organizationId) {
      return jsonResponse({ error: "organization_id is required and must be in your scope" }, 400);
    }

    const crawlerId = Number(ctx.body?.crawler_id || 0);
    if (!Number.isInteger(crawlerId) || crawlerId <= 0) {
      return jsonResponse({ error: "crawler_id must be a positive integer" }, 400);
    }

    const deleted = await deleteCrawlerConfig(organizationId, crawlerId);
    return jsonResponse({ success: deleted });
  } catch (error: any) {
    return jsonResponse({ error: error?.message || String(error) }, 500);
  }
}

export async function crawlerStatusAdminHandler(req: Request, ctx: { url: URL }): Promise<Response> {
  const jobId = (ctx.url.searchParams.get("job_id") || "").trim() || null;
  return jsonResponse(getCrawlerStatus(jobId));
}

export async function stopCrawlerAdminHandler(req: Request, ctx: { body: any; auth: ApiKeyRecord }): Promise<Response> {
  try {
    const organizationId = resolveOrganizationIdForAdmin(ctx.auth, Number(ctx.body?.organization_id));
    if (!organizationId) {
      return jsonResponse({ error: "organization_id is required and must be in your scope" }, 400);
    }

    const result = stopActiveCrawlerJob(organizationId);
    if (!result.stopped) {
      return jsonResponse({ error: result.error || "No active crawler job" }, 409);
    }

    return jsonResponse({ success: true, job_id: result.job_id });
  } catch (error: any) {
    return jsonResponse({ error: error?.message || String(error) }, 500);
  }
}
