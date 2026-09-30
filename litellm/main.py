import json
import os
import secrets
import time
from contextlib import closing
from dataclasses import dataclass
from types import SimpleNamespace
from typing import Any, Optional

import pymysql
from cryptography.fernet import Fernet, InvalidToken
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from litellm import aresponses
from pydantic import BaseModel, Field
from starlette.datastructures import Headers


# ================ Request Models =================

class ResponsesRequest(BaseModel):
    input: str = Field(min_length=1)
    appname: Optional[str] = None
    site: Optional[str] = None
    previous_response_id: Optional[str] = None


class AuthRequest(BaseModel):
    site: Optional[str] = None


class UpdateConfigRequest(BaseModel):
    reload_key: str = Field(min_length=1)


class SitePayload(BaseModel):
    site: str = Field(min_length=1, max_length=255)
    instructions: Optional[str] = None
    model: Optional[str] = None
    api_base: Optional[str] = None
    api_key: Optional[str] = None
    thinking_model: bool = False
    thinking_effort: Optional[str] = None
    tools: Optional[list[Any]] = None
    tool_choice: Optional[str] = None
    include: Optional[list[Any]] = None


class SettingsPayload(BaseModel):
    token_duration: Optional[int] = None
    allowlist: Optional[list[str]] = None
    regenerate_reload_key: bool = False


# ================ Settings (env-backed, static) =================

@dataclass(frozen=True)
class Settings:
    DB_HOST: str
    DB_PORT: int
    MARIADB_DATABASE: str
    DB_USER: str
    MARIADB_APP_PASSWORD: str
    litellm_key: str
    encryption_key: str
    db_table_tokens: str
    db_table_prompts: str
    db_table_sites: str
    db_table_settings: str


SETTINGS: Optional[Settings] = None

SITE_CONFIG_SECRET_PATH = "/run/secrets/litellm_config_json"
CONSOLE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "console")


def read_secret_or_env(name: str) -> Optional[str]:
    secret_file = os.getenv(f"{name}_FILE")
    if secret_file:
        with open(secret_file, "r", encoding="utf-8") as secret_handle:
            return secret_handle.read().strip()
    return os.getenv(name)


def build_settings() -> Settings:
    db_host = os.getenv("DB_HOST")
    db_port_raw = os.getenv("DB_PORT", "3306")
    database = os.getenv("MARIADB_DATABASE")
    db_user = os.getenv("DB_USER")
    app_password = read_secret_or_env("MARIADB_APP_PASSWORD")
    litellm_key = read_secret_or_env("LITELLM_KEY")
    encryption_key = read_secret_or_env("LITELLM_ENCRYPTION_KEY")

    missing = [
        name for name, value in {
            "DB_HOST": db_host,
            "MARIADB_DATABASE": database,
            "DB_USER": db_user,
            "MARIADB_APP_PASSWORD": app_password,
            "LITELLM_KEY": litellm_key,
            "LITELLM_ENCRYPTION_KEY": encryption_key,
        }.items() if not value
    ]
    if missing:
        raise RuntimeError(f"Missing required environment variables: {', '.join(missing)}")

    try:
        db_port = int(db_port_raw)
    except ValueError:
        raise RuntimeError(f"Invalid DB_PORT: {db_port_raw}")

    return Settings(
        DB_HOST=db_host,
        DB_PORT=db_port,
        MARIADB_DATABASE=database,
        DB_USER=db_user,
        MARIADB_APP_PASSWORD=app_password,
        litellm_key=litellm_key,
        encryption_key=encryption_key,
        db_table_tokens=os.getenv("DB_TABLE_TOKENS", "tokens"),
        db_table_prompts=os.getenv("DB_TABLE_PROMPTS", "prompts"),
        db_table_sites=os.getenv("DB_TABLE_SITES", "llm_sites"),
        db_table_settings=os.getenv("DB_TABLE_SETTINGS", "llm_settings"),
    )


# ================ Encryption =================

class ApiKeyCipher:
    """Encrypts site api keys at rest.

    The encryption key is accepted either as a 32-byte urlsafe-base64 string
    (Fernet's native format) or as a 64-char hex string (e.g. openssl rand
    -hex 32) - both are normalized to Fernet format so any generated secret
    works without format coordination.
    """

    def __init__(self, key: str):
        normalized = key.strip()
        if len(normalized) == 64:
            try:
                import base64
                normalized = base64.urlsafe_b64encode(bytes.fromhex(normalized)).decode("ascii")
            except ValueError:
                pass
        self._fernet = Fernet(normalized.encode("utf-8"))

    def encrypt(self, plaintext: str) -> str:
        return self._fernet.encrypt(plaintext.encode("utf-8")).decode("ascii")

    def decrypt(self, ciphertext: str) -> str:
        return self._fernet.decrypt(ciphertext.encode("ascii")).decode("utf-8")


def get_cipher(settings: Settings) -> ApiKeyCipher:
    return ApiKeyCipher(settings.encryption_key)


# ================ Helper Functions =================

def truncate_text(value: str, max_len: int) -> str:
    if max_len <= 0:
        return ""
    return value if len(value) <= max_len else value[:max_len]


def normalize_optional_string(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    stripped = value.strip()
    return stripped if stripped else None


class RuntimeConfig:
    """Per-request view of the DB-backed configuration."""

    def __init__(
        self,
        sites: dict[str, SimpleNamespace],
        token_duration: int,
        allowlist: list[str],
        reload_key: str,
    ):
        self.sites = sites
        self.token_duration = token_duration
        self.allowlist = allowlist
        self.reload_key = reload_key

    def resolve_site(self, value: Optional[str]) -> str:
        normalized_site = normalize_optional_string(value)
        if normalized_site is None or normalized_site not in self.sites:
            raise HTTPException(status_code=403, detail={"error": "Invalid site"})
        return normalized_site


# ================ Database Setup and Operations =================

def db_conn(settings: Settings):
    return pymysql.connect(
        host=settings.DB_HOST,
        port=settings.DB_PORT,
        user=settings.DB_USER,
        password=settings.MARIADB_APP_PASSWORD,
        database=settings.MARIADB_DATABASE,
        charset="utf8mb4",
        cursorclass=pymysql.cursors.DictCursor,
        autocommit=True,
    )


def create_tables(settings: Settings) -> None:
    with closing(db_conn(settings)) as conn, conn.cursor() as cur:
        cur.execute(
            f"""
            CREATE TABLE IF NOT EXISTS `{settings.db_table_tokens}` (
                token VARCHAR(128) PRIMARY KEY,
                site VARCHAR(255) NOT NULL,
                created_at DATETIME NOT NULL,
                expires_at DATETIME NOT NULL,
                INDEX idx_expires_at (expires_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """
        )

        cur.execute(
            f"""
            CREATE TABLE IF NOT EXISTS `{settings.db_table_prompts}` (
                id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                token VARCHAR(128) NOT NULL,
                prompt TEXT,
                started DATETIME NULL,
                ended DATETIME NULL,
                appname VARCHAR(255) NULL,
                endpoint VARCHAR(100) NULL,
                provider VARCHAR(255) NULL,
                ip VARCHAR(64) NULL,
                fingerprint VARCHAR(255) NULL,
                site VARCHAR(255) NULL,
                tool VARCHAR(255) NULL,
                response MEDIUMTEXT NULL,
                error TINYINT(1) NOT NULL DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_token (token),
                INDEX idx_created_at (created_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """
        )

        cur.execute(
            f"""
            CREATE TABLE IF NOT EXISTS `{settings.db_table_sites}` (
                site VARCHAR(255) PRIMARY KEY,
                instructions MEDIUMTEXT NULL,
                model VARCHAR(255) NULL,
                api_base VARCHAR(512) NULL,
                api_key TEXT NULL,
                thinking_model TINYINT(1) NOT NULL DEFAULT 0,
                thinking_effort VARCHAR(32) NULL,
                tools TEXT NULL,
                tool_choice VARCHAR(64) NULL,
                include TEXT NULL,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """
        )

        cur.execute(
            f"""
            CREATE TABLE IF NOT EXISTS `{settings.db_table_settings}` (
                name VARCHAR(64) PRIMARY KEY,
                value TEXT NOT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """
        )


def load_seed_config() -> Optional[dict[str, Any]]:
    if not os.path.isfile(SITE_CONFIG_SECRET_PATH):
        return None
    with open(SITE_CONFIG_SECRET_PATH, "r", encoding="utf-8") as config_file:
        raw_config = json.load(config_file)
    if not isinstance(raw_config, dict):
        raise RuntimeError("Invalid seed config format: expected an object")
    return raw_config


def seed_database_if_empty(settings: Settings) -> None:
    seed_config = load_seed_config()
    cipher = get_cipher(settings)

    with closing(db_conn(settings)) as conn, conn.cursor() as cur:
        cur.execute(f"SELECT COUNT(*) AS c FROM `{settings.db_table_sites}`")
        sites_empty = int(cur.fetchone()["c"]) == 0

        if sites_empty and seed_config is not None:
            sites_value = seed_config.get("sites", [])
            if not isinstance(sites_value, list):
                raise RuntimeError("Invalid seed config: 'sites' must be a list")

            for site_obj in sites_value:
                if not isinstance(site_obj, dict):
                    raise RuntimeError("Invalid seed config: site entries must be objects")
                site_name = str(site_obj.get("site", "")).strip()
                if not site_name:
                    raise RuntimeError("Invalid seed config: missing site name")

                api_key = site_obj.get("api_key")
                cur.execute(
                    f"""
                    INSERT INTO `{settings.db_table_sites}` (
                        site, instructions, model, api_base, api_key, thinking_model,
                        thinking_effort, tools, tool_choice, include
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    """,
                    (
                        site_name,
                        site_obj.get("instructions"),
                        site_obj.get("model"),
                        site_obj.get("api_base"),
                        cipher.encrypt(api_key) if isinstance(api_key, str) and api_key else None,
                        1 if site_obj.get("thinking_model") else 0,
                        site_obj.get("thinking_effort"),
                        json.dumps(site_obj["tools"]) if isinstance(site_obj.get("tools"), list) else None,
                        site_obj.get("tool_choice"),
                        json.dumps(site_obj["include"]) if isinstance(site_obj.get("include"), list) else None,
                    ),
                )

        # Global settings: seed missing rows from seed config (or defaults).
        existing_settings: set[str] = set()
        cur.execute(f"SELECT name FROM `{settings.db_table_settings}`")
        for row in cur.fetchall():
            existing_settings.add(row["name"])

        defaults: dict[str, str] = {
            "token_duration": "60",
            "allowlist": json.dumps(["http://localhost"]),
        }
        if seed_config is not None:
            if seed_config.get("token_duration") is not None:
                defaults["token_duration"] = str(seed_config["token_duration"])
            if seed_config.get("allowlist") is not None:
                defaults["allowlist"] = json.dumps(seed_config["allowlist"])

        for name, value in defaults.items():
            if name not in existing_settings:
                cur.execute(
                    f"INSERT INTO `{settings.db_table_settings}` (name, value) VALUES (%s, %s)",
                    (name, value),
                )

        if "reload_key" not in existing_settings:
            reload_key = None
            if seed_config is not None and isinstance(seed_config.get("reload_key"), str) and seed_config["reload_key"].strip():
                reload_key = seed_config["reload_key"].strip()
            if not reload_key:
                reload_key = secrets.token_hex(32)
            cur.execute(
                f"INSERT INTO `{settings.db_table_settings}` (name, value) VALUES ('reload_key', %s)",
                (reload_key,),
            )


def get_setting(settings: Settings, name: str) -> Optional[str]:
    with closing(db_conn(settings)) as conn, conn.cursor() as cur:
        cur.execute(f"SELECT value FROM `{settings.db_table_settings}` WHERE name = %s LIMIT 1", (name,))
        row = cur.fetchone()
        return row["value"] if row else None


def set_setting(settings: Settings, name: str, value: str) -> None:
    with closing(db_conn(settings)) as conn, conn.cursor() as cur:
        cur.execute(
            f"""
            INSERT INTO `{settings.db_table_settings}` (name, value) VALUES (%s, %s)
            ON DUPLICATE KEY UPDATE value = VALUES(value)
            """,
            (name, value),
        )


def load_runtime_config(settings: Settings) -> RuntimeConfig:
    cipher = get_cipher(settings)

    token_duration_raw = get_setting(settings, "token_duration")
    try:
        token_duration = int(token_duration_raw) if token_duration_raw else 60
    except ValueError:
        token_duration = 60

    allowlist: list[str] = ["http://localhost"]
    allowlist_raw = get_setting(settings, "allowlist")
    if allowlist_raw:
        try:
            parsed = json.loads(allowlist_raw)
            if isinstance(parsed, list):
                allowlist = [str(item) for item in parsed]
        except json.JSONDecodeError:
            pass

    reload_key = get_setting(settings, "reload_key") or ""

    sites: dict[str, SimpleNamespace] = {}
    with closing(db_conn(settings)) as conn, conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT site, instructions, model, api_base, api_key, thinking_model,
                   thinking_effort, tools, tool_choice, include
            FROM `{settings.db_table_sites}`
            """
        )
        for row in cur.fetchall():
            try:
                api_key = cipher.decrypt(row["api_key"]) if row["api_key"] else None
            except InvalidToken:
                api_key = None
            tools = json.loads(row["tools"]) if row["tools"] else None
            include = json.loads(row["include"]) if row["include"] else None
            sites[row["site"]] = SimpleNamespace(
                site=row["site"],
                instructions=row["instructions"],
                model=row["model"],
                api_base=row["api_base"],
                api_key=api_key,
                thinking_model=bool(row["thinking_model"]),
                thinking_effort=row["thinking_effort"],
                tools=tools if isinstance(tools, list) else None,
                tool_choice=row["tool_choice"],
                include=include if isinstance(include, list) else None,
            )

    return RuntimeConfig(
        sites=sites,
        token_duration=token_duration,
        allowlist=allowlist,
        reload_key=reload_key,
    )


def cleanup_expired_tokens(settings: Settings) -> None:
    with closing(db_conn(settings)) as conn, conn.cursor() as cur:
        cur.execute(f"DELETE FROM `{settings.db_table_tokens}` WHERE expires_at < NOW()")


def initialize_database(settings: Settings, retries: int = 20, delay_seconds: float = 1.0) -> None:
    last_error: Optional[BaseException] = None
    for _ in range(retries):
        try:
            create_tables(settings)
            seed_database_if_empty(settings)
            return
        except pymysql.err.OperationalError as exc:
            last_error = exc
            time.sleep(delay_seconds)

    if last_error is not None:
        raise last_error


# ================ Authentication and Token Management =================
def issue_token(settings: Settings, duration_minutes: int, site: str) -> str:
    token = secrets.token_hex(32)
    with closing(db_conn(settings)) as conn, conn.cursor() as cur:
        cur.execute(
            f"INSERT INTO `{settings.db_table_tokens}` (token, site, created_at, expires_at) VALUES (%s, %s, NOW(), DATE_ADD(NOW(), INTERVAL %s MINUTE))",
            (token, site, duration_minutes),
        )
    return token


def validate_token(settings: Settings, authorization: Optional[str], site: Optional[str] = None) -> Optional[str]:
    if not authorization:
        return None

    auth_value = authorization.strip()
    if not auth_value.lower().startswith("bearer "):
        return None

    cleanup_expired_tokens(settings)

    token = auth_value[7:].strip()
    if not token:
        return None

    with closing(db_conn(settings)) as conn, conn.cursor() as cur:
        cur.execute(f"SELECT expires_at, site FROM `{settings.db_table_tokens}` WHERE token = %s LIMIT 1", (token,))
        row = cur.fetchone()
        if not row:
            return None

        token_site = row.get("site")
        if site is None or token_site != site:
            return None

        return token


def require_admin(settings: Settings, authorization: Optional[str]) -> None:
    if not authorization:
        raise HTTPException(status_code=403, detail={"error": "Missing admin key"})
    auth_value = authorization.strip()
    if not auth_value.lower().startswith("bearer "):
        raise HTTPException(status_code=403, detail={"error": "Invalid admin key"})
    provided = auth_value[7:].strip()
    if not provided or not secrets.compare_digest(provided, settings.litellm_key):
        raise HTTPException(status_code=403, detail={"error": "Invalid admin key"})


# ================ Logging =================
def create_prompt_log(
    settings: Settings,
    token: str,
    prompt: str,
    appname: Optional[str],
    endpoint: str,
    model_type: Optional[str],
    site: Optional[str],
    ip_addr: Optional[str],
    fingerprint: Optional[str],
) -> int:
    with closing(db_conn(settings)) as conn, conn.cursor() as cur:
        cur.execute(
            f"""
            INSERT INTO `{settings.db_table_prompts}` (
                token, prompt, started, appname, endpoint, provider, ip, fingerprint, site
            ) VALUES (%s, %s, NOW(), %s, %s, %s, %s, %s, %s)
            """,
            (
                token,
                truncate_text(prompt, 1000),
                appname,
                endpoint,
                model_type,
                ip_addr,
                fingerprint,
                site,
            ),
        )
        return int(cur.lastrowid)


def finish_prompt_success(settings: Settings, prompt_id: int, response_text: Optional[str] = None) -> None:
    with closing(db_conn(settings)) as conn, conn.cursor() as cur:
        if response_text is None:
            cur.execute(f"UPDATE `{settings.db_table_prompts}` SET ended = NOW() WHERE id = %s", (prompt_id,))
        else:
            cur.execute(
                f"UPDATE `{settings.db_table_prompts}` SET ended = NOW(), response = %s WHERE id = %s",
                (truncate_text(response_text, 2000), prompt_id),
            )


def finish_prompt_error(settings: Settings, prompt_id: int, error_text: str) -> None:
    with closing(db_conn(settings)) as conn, conn.cursor() as cur:
        cur.execute(
            f"UPDATE `{settings.db_table_prompts}` SET ended = NOW(), error = TRUE, response = %s WHERE id = %s",
            (truncate_text(error_text, 2000), prompt_id),
        )


def update_prompt_tool(settings: Settings, prompt_id: int, tool_name: str) -> None:
    with closing(db_conn(settings)) as conn, conn.cursor() as cur:
        cur.execute(
            f"UPDATE `{settings.db_table_prompts}` SET tool = %s WHERE id = %s",
            (truncate_text(tool_name, 255), prompt_id),
        )


# ================ Parse Response =================
def extract_final_assistant_completed_text(response: dict[str, Any]) -> Optional[str]:
    output = response.get("output")
    if not isinstance(output, list):
        return None

    final_text: Optional[str] = None
    for item in output:
        if not isinstance(item, dict):
            continue
        if item.get("type") != "message" or item.get("role") != "assistant" or item.get("status") != "completed":
            continue
        content = item.get("content")
        if not isinstance(content, list):
            continue
        for content_item in content:
            if isinstance(content_item, dict) and isinstance(content_item.get("text"), str) and content_item.get("text"):
                final_text = content_item["text"]

    return final_text


def extract_used_tool_name(response: dict[str, Any]) -> Optional[str]:
    output = response.get("output")
    if not isinstance(output, list):
        return None

    used_tool: Optional[str] = None
    for item in output:
        if not isinstance(item, dict):
            continue
        if item.get("type") not in {"mcp_call", "function_call", "tool_call"}:
            continue
        name = item.get("name")
        if isinstance(name, str) and name:
            used_tool = name

    return used_tool


def serialize_response(payload: Any) -> dict[str, Any]:
    if isinstance(payload, dict):
        return payload
    if hasattr(payload, "model_dump"):
        return payload.model_dump()
    if hasattr(payload, "dict"):
        return payload.dict()
    raise RuntimeError("Unexpected response format from LiteLLM")


# ================ CORS Middleware =================
class DynamicCorsMiddleware:
    def __init__(self, app):
        self.app = app

    @staticmethod
    def _cors_headers(origin: str, request_headers: Headers) -> list[tuple[bytes, bytes]]:
        request_allow_headers = request_headers.get("access-control-request-headers") or "Authorization, Content-Type, X-Fingerprint"
        return [
            (b"access-control-allow-origin", origin.encode("utf-8")),
            (b"access-control-allow-credentials", b"true"),
            (b"access-control-allow-methods", b"POST, OPTIONS"),
            (b"access-control-allow-headers", request_allow_headers.encode("utf-8")),
            (b"access-control-max-age", b"600"),
            (b"vary", b"Origin"),
        ]

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        request_headers = Headers(scope=scope)
        origin = request_headers.get("origin")
        settings = SETTINGS

        if origin is None or settings is None:
            await self.app(scope, receive, send)
            return

        try:
            runtime_config = load_runtime_config(settings)
        except Exception:
            runtime_config = None
        allowed_origins = runtime_config.allowlist if runtime_config is not None else []

        if origin not in allowed_origins:
            response = JSONResponse(status_code=403, content={"error": "CORS origin not allowed"})
            await response(scope, receive, send)
            return

        if scope["method"] == "OPTIONS" and request_headers.get("access-control-request-method"):
            response = Response(status_code=204)
            await response(scope, receive, send)
            return

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                message_headers = list(message.get("headers", []))
                message_headers.extend(self._cors_headers(origin, request_headers))
                message["headers"] = message_headers
            await send(message)

        await self.app(scope, receive, send_wrapper)


# ================ App Setup =================
app = FastAPI(title="litellm-backend")
app.add_middleware(DynamicCorsMiddleware)
app.mount("/console", StaticFiles(directory=CONSOLE_DIR, html=True), name="console")


@app.on_event("startup")
def on_startup() -> None:
    global SETTINGS
    SETTINGS = build_settings()
    initialize_database(SETTINGS)


@app.exception_handler(HTTPException)
async def http_exception_handler(_: Request, exc: HTTPException):
    return JSONResponse(status_code=exc.status_code, content=exc.detail if isinstance(exc.detail, dict) else {"error": str(exc.detail)})


def require_settings() -> Settings:
    if SETTINGS is None:
        raise HTTPException(status_code=500, detail={"error": "Server not initialized"})
    return SETTINGS


# ================ Endpoints: Authentication =================
@app.post("/auth")
async def auth(request_body: AuthRequest):
    settings = require_settings()
    runtime_config = load_runtime_config(settings)

    resolved_site = runtime_config.resolve_site(request_body.site)

    return {"token": issue_token(settings, runtime_config.token_duration, resolved_site), "site": resolved_site}


# ================ Endpoints: Configuration =================
@app.post("/update_config")
async def update_config(request_body: UpdateConfigRequest):
    settings = require_settings()
    runtime_config = load_runtime_config(settings)

    provided_reload_key = normalize_optional_string(request_body.reload_key)
    if provided_reload_key is None or not runtime_config.reload_key or not secrets.compare_digest(provided_reload_key, runtime_config.reload_key):
        raise HTTPException(status_code=403, detail={"error": "Invalid reload key"})

    return {"ok": True, "message": "Configuration is read live from the database"}


# ================ Endpoints: Admin (sites + settings) =================
def site_to_dict(site: SimpleNamespace, include_api_key_hint: bool = False) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "site": site.site,
        "instructions": site.instructions,
        "model": site.model,
        "api_base": site.api_base,
        "api_key_set": isinstance(site.api_key, str) and bool(site.api_key),
        "thinking_model": site.thinking_model,
        "thinking_effort": site.thinking_effort,
        "tools": site.tools,
        "tool_choice": site.tool_choice,
        "include": site.include,
    }
    if include_api_key_hint and isinstance(site.api_key, str) and site.api_key:
        payload["api_key_hint"] = "..." + site.api_key[-4:]
    return payload


@app.get("/admin/sites")
async def admin_list_sites(authorization: Optional[str] = Header(default=None)):
    settings = require_settings()
    require_admin(settings, authorization)
    runtime_config = load_runtime_config(settings)
    return {"sites": [site_to_dict(site) for site in runtime_config.sites.values()]}


@app.get("/admin/sites/{site}")
async def admin_get_site(site: str, authorization: Optional[str] = Header(default=None)):
    settings = require_settings()
    require_admin(settings, authorization)
    runtime_config = load_runtime_config(settings)
    site_config = runtime_config.sites.get(site)
    if site_config is None:
        raise HTTPException(status_code=404, detail={"error": "Site not found"})
    return site_to_dict(site_config, include_api_key_hint=True)


def upsert_site(settings: Settings, payload: SitePayload, is_create: bool) -> None:
    cipher = get_cipher(settings)

    tools_json = json.dumps(payload.tools) if payload.tools is not None else None
    include_json = json.dumps(payload.include) if payload.include is not None else None

    with closing(db_conn(settings)) as conn, conn.cursor() as cur:
        if is_create:
            cur.execute(
                f"""
                INSERT INTO `{settings.db_table_sites}` (
                    site, instructions, model, api_base, api_key, thinking_model,
                    thinking_effort, tools, tool_choice, include
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    payload.site.strip(),
                    payload.instructions,
                    payload.model,
                    payload.api_base,
                    cipher.encrypt(payload.api_key) if payload.api_key else None,
                    1 if payload.thinking_model else 0,
                    payload.thinking_effort,
                    tools_json,
                    payload.tool_choice,
                    include_json,
                ),
            )
        else:
            if payload.api_key:
                cur.execute(
                    f"""
                    UPDATE `{settings.db_table_sites}`
                    SET instructions = %s, model = %s, api_base = %s, api_key = %s, thinking_model = %s,
                        thinking_effort = %s, tools = %s, tool_choice = %s, include = %s
                    WHERE site = %s
                    """,
                    (
                        payload.instructions,
                        payload.model,
                        payload.api_base,
                        cipher.encrypt(payload.api_key),
                        1 if payload.thinking_model else 0,
                        payload.thinking_effort,
                        tools_json,
                        payload.tool_choice,
                        include_json,
                        payload.site.strip(),
                    ),
                )
            else:
                cur.execute(
                    f"""
                    UPDATE `{settings.db_table_sites}`
                    SET instructions = %s, model = %s, api_base = %s, thinking_model = %s,
                        thinking_effort = %s, tools = %s, tool_choice = %s, include = %s
                    WHERE site = %s
                    """,
                    (
                        payload.instructions,
                        payload.model,
                        payload.api_base,
                        1 if payload.thinking_model else 0,
                        payload.thinking_effort,
                        tools_json,
                        payload.tool_choice,
                        include_json,
                        payload.site.strip(),
                    ),
                )


@app.post("/admin/sites")
async def admin_create_site(payload: SitePayload, authorization: Optional[str] = Header(default=None)):
    settings = require_settings()
    require_admin(settings, authorization)

    runtime_config = load_runtime_config(settings)
    site_name = payload.site.strip()
    if site_name in runtime_config.sites:
        raise HTTPException(status_code=409, detail={"error": "Site already exists"})

    upsert_site(settings, payload, is_create=True)
    return {"ok": True, "site": site_name}


@app.put("/admin/sites/{site}")
async def admin_update_site(site: str, payload: SitePayload, authorization: Optional[str] = Header(default=None)):
    settings = require_settings()
    require_admin(settings, authorization)

    runtime_config = load_runtime_config(settings)
    if site not in runtime_config.sites:
        raise HTTPException(status_code=404, detail={"error": "Site not found"})
    if payload.site.strip() != site:
        raise HTTPException(status_code=400, detail={"error": "Site name in body must match URL"})

    upsert_site(settings, payload, is_create=False)
    return {"ok": True, "site": site}


@app.delete("/admin/sites/{site}")
async def admin_delete_site(site: str, authorization: Optional[str] = Header(default=None)):
    settings = require_settings()
    require_admin(settings, authorization)

    with closing(db_conn(settings)) as conn, conn.cursor() as cur:
        cur.execute(f"DELETE FROM `{settings.db_table_sites}` WHERE site = %s", (site,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail={"error": "Site not found"})

    return {"ok": True, "deleted": site}


@app.get("/admin/settings")
async def admin_get_settings(authorization: Optional[str] = Header(default=None)):
    settings = require_settings()
    require_admin(settings, authorization)
    runtime_config = load_runtime_config(settings)
    return {
        "token_duration": runtime_config.token_duration,
        "allowlist": runtime_config.allowlist,
        "reload_key": runtime_config.reload_key,
    }


@app.put("/admin/settings")
async def admin_update_settings(payload: SettingsPayload, authorization: Optional[str] = Header(default=None)):
    settings = require_settings()
    require_admin(settings, authorization)

    if payload.token_duration is not None:
        if payload.token_duration < 1:
            raise HTTPException(status_code=400, detail={"error": "token_duration must be a positive integer"})
        set_setting(settings, "token_duration", str(payload.token_duration))

    if payload.allowlist is not None:
        set_setting(settings, "allowlist", json.dumps([str(origin) for origin in payload.allowlist]))

    if payload.regenerate_reload_key:
        set_setting(settings, "reload_key", secrets.token_hex(32))

    return {"ok": True}


# ================ Endpoints: Responses =================
@app.post("/responses")
async def responses(
    request_body: ResponsesRequest,
    request: Request,
    authorization: Optional[str] = Header(default=None),
    x_fingerprint: Optional[str] = Header(default=None),
):
    settings = require_settings()
    runtime_config = load_runtime_config(settings)

    resolved_site = runtime_config.resolve_site(request_body.site)

    token = validate_token(settings, authorization, resolved_site)
    if token is None:
        raise HTTPException(status_code=403, detail={"error": "Invalid or expired token"})

    prompt = request_body.input.strip()
    if not prompt:
        raise HTTPException(status_code=400, detail={"error": "Parameter input cannot be empty"})

    appname = normalize_optional_string(request_body.appname)
    site_settings = runtime_config.sites[resolved_site]
    default_site_settings = runtime_config.sites.get("default")

    def get_site_config_value(key: str) -> Any:
        site_value = getattr(site_settings, key, None)
        if site_value is not None:
            return site_value
        return getattr(default_site_settings, key, None) if default_site_settings is not None else None

    previous_response_id = normalize_optional_string(request_body.previous_response_id)
    include_instructions = previous_response_id is None
    model = get_site_config_value("model")

    if not isinstance(model, str) or not model.strip():
        raise HTTPException(status_code=500, detail={"error": f"Missing model for site '{resolved_site}'"})

    api_key = get_site_config_value("api_key")
    api_base = get_site_config_value("api_base")
    if not isinstance(api_key, str) or not api_key:
        raise HTTPException(status_code=500, detail={"error": f"Missing api_key for site '{resolved_site}'"})
    if not isinstance(api_base, str) or not api_base:
        raise HTTPException(status_code=500, detail={"error": f"Missing api_base for site '{resolved_site}'"})

    prompt_id = create_prompt_log(
        settings,
        token=token,
        prompt=prompt,
        appname=appname,
        endpoint="responses",
        model_type=model,
        site=resolved_site,
        ip_addr=request.client.host if request.client else None,
        fingerprint=x_fingerprint,
    )

    input_payload: list[dict[str, Any]] = []
    instructions = get_site_config_value("instructions")
    if include_instructions and isinstance(instructions, str) and instructions:
        input_payload.append({"role": "developer", "content": instructions})
    input_payload.append({"role": "user", "content": prompt})

    litellm_payload: dict[str, Any] = {
        "model": model,
        "input": input_payload,
        "stream": False,
        "text": {"format": {"type": "text"}},
    }

    if bool(get_site_config_value("thinking_model")):
        reasoning_effort = get_site_config_value("thinking_effort") or "low"
        litellm_payload["reasoning"] = {"effort": reasoning_effort}

    tools = get_site_config_value("tools")
    if isinstance(tools, list):
        litellm_payload["tools"] = tools

    tool_choice = get_site_config_value("tool_choice")
    if tool_choice is not None:
        litellm_payload["tool_choice"] = tool_choice

    include = get_site_config_value("include")
    if isinstance(include, list) and include:
        litellm_payload["include"] = include

    if previous_response_id:
        litellm_payload["previous_response_id"] = previous_response_id

    litellm_payload["api_key"] = api_key
    litellm_payload["api_base"] = api_base

    try:
        llm_response = await aresponses(**litellm_payload)
        response_payload = serialize_response(llm_response)
    except Exception as exc:
        finish_prompt_error(settings, prompt_id, str(exc))
        raise HTTPException(status_code=500, detail={"error": str(exc)}) from exc

    used_tool = extract_used_tool_name(response_payload)
    if used_tool:
        update_prompt_tool(settings, prompt_id, used_tool)

    final_text = extract_final_assistant_completed_text(response_payload)
    finish_prompt_success(settings, prompt_id, final_text)

    return JSONResponse(content=response_payload)


# ================ Endpoints: Health =================

@app.get("/health")
async def health():
    return {"ok": True}


@app.get("/")
async def root():
    return {"service": "litellm-backend", "console": "/console"}
