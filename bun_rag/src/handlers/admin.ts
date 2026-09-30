import {
  addOrganization,
  addProject,
  ApiKeyRecord,
  assertCallerCanAssignProjects,
  deleteApiKey,
  deleteOrganization,
  deleteProject,
  disableApiKey,
  enableApiKey,
  getApiKeyMetadata,
  hasPrivilege,
  issueApiKey,
  listApiKeys,
  listOrganizations,
  listProjects,
  replaceApiKeyProjectAccess,
  updateProject,
} from "../auth.js";
import { authScope } from "../auth_scope.js";
import { config } from "../config.js";
import { jsonResponse } from "../http.js";
import { logger } from "../config.js";
import {
  addOrganizationBodySchema,
  addProjectBodySchema,
  deleteOrganizationBodySchema,
  deleteProjectBodySchema,
  issueKeyBodySchema,
  keyActionBodySchema,
  listProjectsBodySchema,
  updateProjectBodySchema,
} from "../schema.js";
import { RouteMeta } from "../openapi.js";

export async function checkKeyHandler(req: Request, ctx: { auth: ApiKeyRecord }): Promise<Response> {
  try {
    return jsonResponse({ success: true, level: ctx.auth.privilege_level });
  } catch {
    return jsonResponse({ error: "Invalid API key" }, 401);
  }
}

export async function issueKeyHandler(req: Request, ctx: { body: any; auth: ApiKeyRecord }): Promise<Response> {
  try {
    const parsed = issueKeyBodySchema.safeParse(ctx.body ?? {});
    if (!parsed.success) {
      return jsonResponse({ error: parsed.error.issues[0]?.message || "Invalid request body" }, 400);
    }

    const {
      username,
      privilege_level = config.privilege.user,
      valid_until_unix = 0,
      organization_id,
      project_ids = [],
    } = parsed.data;

    const requestedPrivilege = Number(privilege_level);
    if (!Number.isFinite(requestedPrivilege)) {
      return jsonResponse({ error: "privilege_level must be a number" }, 400);
    }

    const callerIsSuperadmin = hasPrivilege(ctx.auth, config.privilege.superadmin) && ctx.auth.organization_id == null;
    if (!callerIsSuperadmin && requestedPrivilege >= config.privilege.superadmin) {
      return jsonResponse({ error: "Only superadmin can issue superadmin keys" }, 403);
    }

    if (!callerIsSuperadmin && requestedPrivilege >= config.privilege.admin && !hasPrivilege(ctx.auth, config.privilege.admin)) {
      return jsonResponse({ error: "Only admin or superadmin can issue admin keys" }, 403);
    }

    if (!callerIsSuperadmin && requestedPrivilege >= config.privilege.projectadmin && !hasPrivilege(ctx.auth, config.privilege.projectadmin)) {
      return jsonResponse({ error: "Caller lacks privilege to issue requested key" }, 403);
    }

    let validUntilUnix = 0;
    if (Number(valid_until_unix) > 0) {
      validUntilUnix = Math.floor(Number(valid_until_unix));
    }

    let targetOrganizationId: number | null = null;
    if (requestedPrivilege < config.privilege.superadmin) {
      if (callerIsSuperadmin) {
        const parsedOrg = Number(organization_id);
        if (!Number.isInteger(parsedOrg) || parsedOrg <= 0) {
          return jsonResponse({ error: "organization_id is required for non-superadmin keys" }, 400);
        }
        targetOrganizationId = parsedOrg;
      } else {
        targetOrganizationId = ctx.auth.organization_id;
        if (!targetOrganizationId) {
          return jsonResponse({ error: "Admin key is not organization-bound" }, 403);
        }
      }
    }

    const effectiveOrgId = requestedPrivilege >= config.privilege.superadmin ? null : Number(targetOrganizationId ?? 0);

    let resolvedProjectIds: number[] = [];
    if (effectiveOrgId != null && effectiveOrgId > 0) {
      resolvedProjectIds = await assertCallerCanAssignProjects(ctx.auth, effectiveOrgId, requestedPrivilege, project_ids);
    }

    const issued = await issueApiKey(username, requestedPrivilege, {
      organizationId: targetOrganizationId,
      validUntilUnix,
    });

    if (requestedPrivilege < config.privilege.admin) {
      await replaceApiKeyProjectAccess(issued.keyId, resolvedProjectIds);
    }

    return jsonResponse({
      success: true,
      api_key: `Bearer ${issued.plainKey}`,
      key_id: issued.keyId,
      message: "API key issued. This is the only time this key will be shown. Store it securely.",
      username,
      privilege_level: requestedPrivilege,
      organization_id: targetOrganizationId,
      project_ids: requestedPrivilege >= config.privilege.admin ? [] : resolvedProjectIds,
      valid_until: validUntilUnix === 0 ? "never" : new Date(validUntilUnix * 1000).toISOString(),
    });
  } catch (error) {
    logger.error({ err: error }, "Issue key error");
    return jsonResponse({ error: `Failed to issue key: ${error}` }, 500);
  }
}

export async function deleteKeyHandler(req: Request, ctx: { body: any; auth: ApiKeyRecord }): Promise<Response> {
  try {
    const parsed = keyActionBodySchema.safeParse(ctx.body ?? {});
    if (!parsed.success) {
      return jsonResponse({ error: parsed.error.issues[0]?.message || "Invalid request body" }, 400);
    }
    const { key_id } = parsed.data;

    const scope = await authScope(ctx.auth);

    if (!hasPrivilege(ctx.auth, config.privilege.admin)) {
      const target = await getApiKeyMetadata(String(key_id));
      if (!target) return jsonResponse({ error: "Key not found" }, 404);
      if (target.organization_id !== ctx.auth.organization_id) return jsonResponse({ error: "Cannot delete key outside your organization" }, 403);
      if (target.privilege_level >= config.privilege.admin) return jsonResponse({ error: "Projectadmin cannot delete admin or superadmin keys" }, 403);
      const ownProjects = new Set(scope.projectIds);
      const targetProjects = Array.isArray(target.project_ids) ? target.project_ids : [];
      if (!targetProjects.every((id: number) => ownProjects.has(Number(id)))) {
        return jsonResponse({ error: "Cannot delete key outside your project scope" }, 403);
      }
    }

    const success = await deleteApiKey(key_id, scope.globalScope ? null : scope.organizationId);
    if (!success) return jsonResponse({ error: "Key not found" }, 404);

    return jsonResponse({ success: true, message: "Key deleted" });
  } catch (error) {
    logger.error({ err: error }, "Delete key error");
    return jsonResponse({ error: `Failed to delete key: ${error}` }, 500);
  }
}

export async function listKeysHandler(req: Request, ctx: { auth: ApiKeyRecord }): Promise<Response> {
  try {
    const scope = await authScope(ctx.auth);
    let keys = await listApiKeys(scope.globalScope ? null : scope.organizationId);

    if (!hasPrivilege(ctx.auth, config.privilege.admin)) {
      const allowed = new Set(scope.projectIds);
      keys = keys.filter((k: any) => {
        if (k.organization_id !== ctx.auth.organization_id) return false;
        const keyProjects = Array.isArray(k.project_ids) ? k.project_ids : [];
        return keyProjects.every((id: number) => allowed.has(Number(id)));
      });
    }

    return jsonResponse({ success: true, keys });
  } catch (error) {
    logger.error({ err: error }, "List keys error");
    return jsonResponse({ error: `Failed to list keys: ${error}` }, 500);
  }
}

export async function disableKeyHandler(req: Request, ctx: { body: any; auth: ApiKeyRecord }): Promise<Response> {
  try {
    const parsed = keyActionBodySchema.safeParse(ctx.body ?? {});
    if (!parsed.success) return jsonResponse({ error: parsed.error.issues[0]?.message || "Invalid request body" }, 400);

    const scope = await authScope(ctx.auth);
    const success = await disableApiKey(parsed.data.key_id, scope.globalScope ? null : scope.organizationId);
    if (!success) return jsonResponse({ error: "Key not found" }, 404);

    return jsonResponse({ success: true, message: "Key disabled" });
  } catch (error) {
    logger.error({ err: error }, "Disable key error");
    return jsonResponse({ error: `Failed to disable key: ${error}` }, 500);
  }
}

export async function enableKeyHandler(req: Request, ctx: { body: any; auth: ApiKeyRecord }): Promise<Response> {
  try {
    const parsed = keyActionBodySchema.safeParse(ctx.body ?? {});
    if (!parsed.success) return jsonResponse({ error: parsed.error.issues[0]?.message || "Invalid request body" }, 400);

    const scope = await authScope(ctx.auth);
    const success = await enableApiKey(parsed.data.key_id, scope.globalScope ? null : scope.organizationId);
    if (!success) return jsonResponse({ error: "Key not found" }, 404);

    return jsonResponse({ success: true, message: "Key enabled" });
  } catch (error) {
    logger.error({ err: error }, "Enable key error");
    return jsonResponse({ error: `Failed to enable key: ${error}` }, 500);
  }
}

export async function addOrganizationHandler(req: Request, ctx: { body: any }): Promise<Response> {
  try {
    const parsed = addOrganizationBodySchema.safeParse(ctx.body ?? {});
    if (!parsed.success) return jsonResponse({ error: parsed.error.issues[0]?.message || "Invalid request body" }, 400);
    const organization = await addOrganization(parsed.data.slug, parsed.data.name);
    return jsonResponse({ success: true, organization });
  } catch (error) {
    logger.error({ err: error }, "Add organization error");
    return jsonResponse({ error: `Failed to add organization: ${error}` }, 500);
  }
}

export async function listOrganizationsHandler(req: Request, ctx: { auth: ApiKeyRecord }): Promise<Response> {
  try {
    const organizations = await listOrganizations();
    const callerIsSuperadmin = hasPrivilege(ctx.auth, config.privilege.superadmin) && ctx.auth.organization_id == null;
    const filtered = callerIsSuperadmin
      ? organizations
      : organizations.filter((o: any) => Number(o.organization_id) === Number(ctx.auth.organization_id));
    return jsonResponse({ success: true, organizations: filtered });
  } catch (error) {
    logger.error({ err: error }, "List organizations error");
    return jsonResponse({ error: `Failed to list organizations: ${error}` }, 500);
  }
}

export async function listProjectsHandler(req: Request, ctx: { body: any; auth: ApiKeyRecord }): Promise<Response> {
  try {
    const parsed = listProjectsBodySchema.safeParse(ctx.body ?? {});
    if (!parsed.success) return jsonResponse({ error: parsed.error.issues[0]?.message || "Invalid request body" }, 400);

    const requestedOrg = Number(parsed.data.organization_id ?? 0);
    const callerScope = await authScope(ctx.auth);

    if (callerScope.globalScope) {
      const projects = Number.isInteger(requestedOrg) && requestedOrg > 0 ? await listProjects(requestedOrg) : await listProjects();
      return jsonResponse({ success: true, projects });
    }

    const orgId = Number(ctx.auth.organization_id ?? 0);
    if (!Number.isInteger(orgId) || orgId <= 0) return jsonResponse({ error: "Organization-bound API key is required" }, 403);

    const allOrgProjects = await listProjects(orgId);
    if (hasPrivilege(ctx.auth, config.privilege.admin)) return jsonResponse({ success: true, projects: allOrgProjects });

    const allowed = new Set(callerScope.projectIds);
    const filtered = allOrgProjects.filter((p: any) => allowed.has(Number(p.project_id)));
    return jsonResponse({ success: true, projects: filtered });
  } catch (error) {
    logger.error({ err: error }, "List projects error");
    return jsonResponse({ error: `Failed to list projects: ${error}` }, 500);
  }
}

export async function addProjectHandler(req: Request, ctx: { body: any; auth: ApiKeyRecord }): Promise<Response> {
  try {
    const parsed = addProjectBodySchema.safeParse(ctx.body ?? {});
    if (!parsed.success) return jsonResponse({ error: parsed.error.issues[0]?.message || "Invalid request body" }, 400);

    const { slug, name, description, organization_id } = parsed.data;
    const callerIsSuperadmin = hasPrivilege(ctx.auth, config.privilege.superadmin) && ctx.auth.organization_id == null;
    const targetOrg = callerIsSuperadmin ? Number(organization_id) : Number(ctx.auth.organization_id ?? 0);

    if (!Number.isInteger(targetOrg) || targetOrg <= 0) return jsonResponse({ error: "organization_id is required" }, 400);

    const project = await addProject(targetOrg, slug, name, description);
    return jsonResponse({ success: true, project });
  } catch (error) {
    logger.error({ err: error }, "Add project error");
    return jsonResponse({ error: `Failed to add project: ${error}` }, 500);
  }
}

export async function updateProjectHandler(req: Request, ctx: { body: any; auth: ApiKeyRecord }): Promise<Response> {
  try {
    const parsed = updateProjectBodySchema.safeParse(ctx.body ?? {});
    if (!parsed.success) return jsonResponse({ error: parsed.error.issues[0]?.message || "Invalid request body" }, 400);

    const { project_id, name, description } = parsed.data;
    const projectId = Number(project_id);
    if (!hasPrivilege(ctx.auth, config.privilege.admin)) return jsonResponse({ error: "Admin privilege required" }, 403);

    if (!hasPrivilege(ctx.auth, config.privilege.superadmin)) {
      const ownScope = await authScope(ctx.auth);
      if (!ownScope.projectIds.includes(projectId)) return jsonResponse({ error: "Cannot update project outside your organization" }, 403);
    }

    const updates: { name?: string; description?: string | null } = {};
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;
    if (updates.name === undefined && updates.description === undefined) {
      return jsonResponse({ error: "At least one updatable field is required" }, 400);
    }

    const project = await updateProject(projectId, updates);
    if (!project) return jsonResponse({ error: "Project not found" }, 404);

    return jsonResponse({ success: true, project });
  } catch (error) {
    logger.error({ err: error }, "Update project error");
    return jsonResponse({ error: `Failed to update project: ${error}` }, 500);
  }
}

export async function deleteProjectHandler(req: Request, ctx: { body: any; auth: ApiKeyRecord }): Promise<Response> {
  try {
    const parsed = deleteProjectBodySchema.safeParse(ctx.body ?? {});
    if (!parsed.success) return jsonResponse({ error: parsed.error.issues[0]?.message || "Invalid request body" }, 400);

    const projectId = Number(parsed.data.project_id);
    if (!hasPrivilege(ctx.auth, config.privilege.admin)) return jsonResponse({ error: "Admin privilege required" }, 403);

    if (!hasPrivilege(ctx.auth, config.privilege.superadmin)) {
      const ownScope = await authScope(ctx.auth);
      if (!ownScope.projectIds.includes(projectId)) return jsonResponse({ error: "Cannot delete project outside your organization" }, 403);
    }

    const success = await deleteProject(projectId);
    if (!success) return jsonResponse({ error: "Project not found" }, 404);

    return jsonResponse({ success: true, project_id: projectId, deleted: true });
  } catch (error) {
    logger.error({ err: error }, "Delete project error");
    return jsonResponse({ error: `Failed to delete project: ${error}` }, 500);
  }
}

export async function deleteOrganizationHandler(req: Request, ctx: { body: any }): Promise<Response> {
  try {
    const parsed = deleteOrganizationBodySchema.safeParse(ctx.body ?? {});
    if (!parsed.success) return jsonResponse({ error: parsed.error.issues[0]?.message || "Invalid request body" }, 400);

    const parsedOrg = Number(parsed.data.organization_id);
    const success = await deleteOrganization(parsedOrg);
    if (!success) return jsonResponse({ error: "Organization not found" }, 404);

    return jsonResponse({ success: true, organization_id: parsedOrg, deleted: true });
  } catch (error) {
    logger.error({ err: error }, "Delete organization error");
    return jsonResponse({ error: `Failed to delete organization: ${error}` }, 500);
  }
}

export async function listRoutesHandler(
  req: Request,
  ctx: { auth: ApiKeyRecord },
  routes: Map<string, RouteMeta>
): Promise<Response> {
  try {
    const currentLevel = Number(ctx.auth?.privilege_level ?? config.privilege.user);
    const availableRoutes = Array.from(routes.entries())
      .filter(([, routeMeta]) => currentLevel >= routeMeta.privilege)
      .map(([routeKey, routeMeta]) => {
        const firstSpace = routeKey.indexOf(" ");
        const method = firstSpace > 0 ? routeKey.slice(0, firstSpace) : routeKey;
        const path = firstSpace > 0 ? routeKey.slice(firstSpace + 1) : "";
        return {
          method,
          path,
          required_privilege: routeMeta.privilege,
          expects_json_body: routeMeta.parseJson,
        };
      })
      .sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));

    return jsonResponse({ success: true, auth_level: currentLevel, routes: availableRoutes });
  } catch (error) {
    logger.error({ err: error }, "List routes error");
    return jsonResponse({ error: `Failed to list routes: ${error}` }, 500);
  }
}
