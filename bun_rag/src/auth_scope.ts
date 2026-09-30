import {
  validateApiKey,
  hasPrivilege,
  resolveAccessibleProjectIdsForKey,
  ApiKeyRecord,
} from "./auth.js";
import { config } from "./config.js";
import { jsonResponse } from "./http.js";

export type AccessScope = {
  organizationId: number | null;
  globalScope: boolean;
  projectIds: number[];
};

export type AuthResult = ApiKeyRecord | { response: Response };

export const requireAuth = async (request: Request, level: number = config.privilege.user): Promise<AuthResult> => {
  const authHeader = request.headers.get("authorization") || undefined;
  if (!authHeader) {
    return { response: jsonResponse({ error: "Unauthorized: API key required" }, 401) };
  }

  const apiKey = await validateApiKey(authHeader);
  if (!apiKey) {
    return { response: jsonResponse({ error: "Unauthorized: API key required" }, 401) };
  }

  if (!hasPrivilege(apiKey, level)) {
    return {
      response: jsonResponse({ error: `Forbidden: requires privilege level ${level}` }, 403),
    };
  }

  return apiKey;
};

export const authScope = async (apiKey: ApiKeyRecord): Promise<AccessScope> => {
  const globalScope = hasPrivilege(apiKey, config.privilege.superadmin) && apiKey.organization_id == null;
  return {
    organizationId: apiKey.organization_id,
    globalScope,
    projectIds: await resolveAccessibleProjectIdsForKey(apiKey),
  };
};
