const API_URL = window.location.origin;
const API_KEY_STORAGE_KEY = "rag_admin_api_key";

const readStoredApiKey = () => {
  try {
    return sessionStorage.getItem(API_KEY_STORAGE_KEY);
  } catch {
    return null;
  }
};

const writeStoredApiKey = (apiKey) => {
  try {
    if (apiKey) {
      sessionStorage.setItem(API_KEY_STORAGE_KEY, apiKey);
    } else {
      sessionStorage.removeItem(API_KEY_STORAGE_KEY);
    }
  } catch {
    // sessionStorage unavailable (private mode); keep in-memory only
  }
};

class ApiClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.apiKey = readStoredApiKey();
  }

  setApiKey(rawKey) {
    this.apiKey = rawKey?.trim() || null;
    writeStoredApiKey(this.apiKey);
  }

  clearApiKey() {
    this.apiKey = null;
    writeStoredApiKey(null);
  }

  getAuthHeader() {
    if (!this.apiKey) return null;
    return this.apiKey.startsWith("Bearer ") ? this.apiKey : `Bearer ${this.apiKey}`;
  }

  async request(path, { method = "GET", body, headers } = {}) {
    const finalHeaders = {
      ...(headers || {}),
    };

    const authHeader = this.getAuthHeader();
    if (authHeader) {
      finalHeaders.Authorization = authHeader;
    }

    let payload;
    if (body !== undefined && body !== null) {
      finalHeaders["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }

    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: finalHeaders,
      body: payload,
    });

    const contentType = response.headers.get("content-type") || "";
    const rawText = await response.text();
    let data = null;

    if (rawText) {
      if (contentType.includes("application/json")) {
        try {
          data = JSON.parse(rawText);
        } catch {
          data = null;
        }
      } else {
        data = rawText;
      }
    }

    return { response, data, rawText };
  }
}

export { API_URL, ApiClient };
