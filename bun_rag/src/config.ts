import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { readFileSync } from "fs";
import pino from "pino";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const envConfig: Record<string, string | undefined> = {};
for (const [key, value] of Object.entries(process.env)) {
  envConfig[key] = value;
}

const parsePositiveInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

const resolveSecretValue = (name: string): string | undefined => {
  const filePath = process.env[`${name}_FILE`];
  if (filePath) {
    return readFileSync(filePath, "utf8").trim();
  }
  return process.env[name];
};

export const config: any = {
  ...envConfig,
  DEFAULT_SUPERADMIN_API_KEY: resolveSecretValue("DEFAULT_SUPERADMIN_API_KEY"),
  DEFAULT_ADMIN_API_KEY: resolveSecretValue("DEFAULT_ADMIN_API_KEY"),
  API_KEY_SECRET: resolveSecretValue("API_KEY_SECRET"),
  EMBEDDINGS_API_KEY: resolveSecretValue("EMBEDDINGS_API_KEY"),
  MARIADB_APP_PASSWORD: resolveSecretValue("MARIADB_APP_PASSWORD"),
  PUBLIC_DIR: resolve(__dirname, "..", "public"),
  MAX_JSON_BYTES: 25 * 1024 * 1024,
  DEFAULT_MAX_CHARS: 1000,
  LOG_LEVEL: envConfig.LOG_LEVEL || "info",
  LOG_PRETTY: envConfig.LOG_PRETTY || "false",
  BUN_HOST: envConfig.BUN_HOST || "127.0.0.1",
  BUN_PORT: envConfig.BUN_PORT || "3000",
  DB_PORT: envConfig.DB_PORT || "3306",
  DB_TABLE_ORGANIZATIONS: "organizations",
  DB_TABLE_PROJECTS: "projects",
  DB_TABLE_DOCUMENT_PROJECTS: "document_projects",
  DB_TABLE_API_KEY_PROJECTS: "api_key_projects",
  EMBEDDINGS_URL: envConfig.EMBEDDINGS_URL || "http://embedding:8000/v1/embeddings",
  EMBEDDINGS_MODEL: envConfig.EMBEDDINGS_MODEL || "google/embeddinggemma-300m",
  EMBEDDINGS_METRICS_URL: envConfig.EMBEDDINGS_METRICS_URL || "http://embedding:8000/metrics",
  CONVERT_MARKDOWN_URL: envConfig.CONVERT_MARKDOWN_URL || "http://embedding:8000/extract-markdown",
  REQUEST_TIMEOUT: parsePositiveInt(envConfig.REQUEST_TIMEOUT, 60000),
  EMBEDDING_BATCH_THRESHOLD: parsePositiveInt(envConfig.EMBEDDING_BATCH_THRESHOLD, 100),
  DEFAULT_ORGANIZATION_SLUG: "default-organization",
  DEFAULT_ORGANIZATION_NAME: "Default Organization",
  DEFAULT_PROJECT_SLUG: "default-project",
  DEFAULT_PROJECT_NAME: "Default Project",
  privilege: {
    user: 0,
    editor: 30,
    projectadmin: 50,
    admin: 100,
    superadmin: 1000,
  },
};

export const logger = pino(
  {
    level: config.LOG_LEVEL || "debug",
    base: null,
    timestamp: false,
  },
  config.LOG_PRETTY === "true"
    ? pino.transport({
        target: "pino-pretty",
        options: {
          colorize: true,
          ignore: "pid,hostname",
          translateTime: false,
          singleLine: false,
        },
      })
    : undefined
);
