import os
import secrets
import json
import time
from contextlib import closing
from dataclasses import dataclass, fields
from types import SimpleNamespace
from typing import Any, Optional, get_origin

import pymysql
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse, Response
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


# ================ Settings (Runtime Secret Config) =================

@dataclass(frozen=True)
class Settings:
    DB_HOST: str
    DB_PORT: int
    MARIADB_DATABASE: str
    DB_USER: str
    MARIADB_APP_PASSWORD: str
    db_table_tokens: str
    db_table_prompts: str
    token_duration: int
    reload_key: str
    allowlist: list[str]
    sites: dict[str, SimpleNamespace]

    def __getattr__(self, name: str) -> Any:
        site = self.sites.get(name)
        if site is not None:
            return site
        raise AttributeError(f"Settings has no attribute '{name}'")
    
SETTINGS: Optional[Settings] = None


def resolve_site_config_path() -> str:
    docker_secret_path = "/run/secrets/litellm_config_json"
    if os.path.isfile(docker_secret_path):
        return docker_secret_path

    raise RuntimeError(
        "LiteLLM config path not found. Mount /run/secrets/litellm_config_json."
    )


def read_secret_or_env(name: str) -> Optional[str]:
    secret_file = os.getenv(f"{name}_FILE")
    if secret_file:
        with open(secret_file, "r", encoding="utf-8") as secret_handle:
            return secret_handle.read().strip()
    return os.getenv(name)


def build_settings() -> Settings:
    config_path = resolve_site_config_path()
    with open(config_path, "r", encoding="utf-8") as config_file:
        raw_config = json.load(config_file)

    if not isinstance(raw_config, dict):
        raise RuntimeError("Invalid config.json format: expected an object")

    env_backed_keys = {
        "DB_HOST": lambda: os.getenv("DB_HOST"),
        "DB_PORT": lambda: os.getenv("DB_PORT"),
        "MARIADB_DATABASE": lambda: os.getenv("MARIADB_DATABASE"),
        "DB_USER": lambda: os.getenv("DB_USER"),
        "MARIADB_APP_PASSWORD": lambda: read_secret_or_env("MARIADB_APP_PASSWORD"),
    }

    payload: dict[str, Any] = {}
    for field_def in fields(Settings):
        key = field_def.name
        value = env_backed_keys[key]() if key in env_backed_keys else raw_config.get(key)

        if value is None:
            raise RuntimeError(f"Missing required config key: {key}")

        if key == "sites":
            if not isinstance(value, list):
                raise RuntimeError(f"Invalid config type for key: {key}")

            sites_payload: dict[str, SimpleNamespace] = {}
            for site_obj in value:
                if not isinstance(site_obj, dict):
                    raise RuntimeError(f"Invalid config type for key: {key}")

                site_name = str(site_obj.get("site", "")).strip()
                if not site_name:
                    raise RuntimeError("Missing required config key: site")
                if site_name in sites_payload:
                    raise RuntimeError(f"Duplicate site entry: {site_name}")

                sites_payload[site_name] = SimpleNamespace(**site_obj)

            payload[key] = sites_payload
            continue

        expected_type = get_origin(field_def.type) or field_def.type
        if expected_type is int and isinstance(value, str):
            value = int(value)

        if not isinstance(value, expected_type):
            raise RuntimeError(f"Invalid config type for key: {key}")

        payload[key] = value

    return Settings(**payload)


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


def resolve_auth_site(settings: Settings, value: Optional[str]) -> str:
    normalized_site = normalize_optional_string(value)
    if normalized_site is None or normalized_site not in settings.sites:
        raise HTTPException(status_code=403, detail={"error": "Invalid site"})
    return normalized_site


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
        allowed_origins = settings.allowlist if settings is not None else []

        if origin is None:
            await self.app(scope, receive, send)
            return

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
            f"SHOW COLUMNS FROM `{settings.db_table_tokens}` LIKE 'site'"
        )
        if cur.fetchone() is None:
            try:
                cur.execute(f"ALTER TABLE `{settings.db_table_tokens}` ADD COLUMN site VARCHAR(255) NULL AFTER token")
            except pymysql.err.OperationalError as exc:
                if not exc.args or exc.args[0] != 1060:
                    raise

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


def cleanup_expired_tokens(settings: Settings) -> None:
    with closing(db_conn(settings)) as conn, conn.cursor() as cur:
        cur.execute(f"DELETE FROM `{settings.db_table_tokens}` WHERE expires_at < NOW()")


def initialize_database(settings: Settings, retries: int = 20, delay_seconds: float = 1.0) -> None:
    last_error: Optional[BaseException] = None
    for _ in range(retries):
        try:
            create_tables(settings)
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


# ================ App Setup =================
app = FastAPI(title="litellm-backend")
app.add_middleware(DynamicCorsMiddleware)


@app.on_event("startup")
def on_startup() -> None:
    global SETTINGS
    SETTINGS = build_settings()
    initialize_database(SETTINGS)


@app.exception_handler(HTTPException)
async def http_exception_handler(_: Request, exc: HTTPException):
    return JSONResponse(status_code=exc.status_code, content=exc.detail if isinstance(exc.detail, dict) else {"error": str(exc.detail)})


# ================ Endpoints: Authentication =================
@app.post("/auth")
async def auth(request_body: AuthRequest):
    if SETTINGS is None:
        raise HTTPException(status_code=500, detail={"error": "Server not initialized"})

    resolved_site = resolve_auth_site(SETTINGS, request_body.site)

    return {"token": issue_token(SETTINGS, SETTINGS.token_duration, resolved_site), "site": resolved_site}


# ================ Endpoints: Configuration =================
@app.post("/update_config")
async def update_config(request_body: UpdateConfigRequest):
    global SETTINGS

    if SETTINGS is None:
        raise HTTPException(status_code=500, detail={"error": "Server not initialized"})

    provided_reload_key = normalize_optional_string(request_body.reload_key)
    if provided_reload_key is None or not secrets.compare_digest(provided_reload_key, SETTINGS.reload_key):
        raise HTTPException(status_code=403, detail={"error": "Invalid reload key"})

    try:
        reloaded_settings = build_settings()
    except Exception as exc:
        return JSONResponse(status_code=500, content={"ok": False, "error": f"Config reload failed: {str(exc)}"})

    SETTINGS = reloaded_settings
    return {"ok": True, "message": "Config reloaded successfully"}


# ================ Endpoints: Responses =================
@app.post("/responses")
async def responses(
    request_body: ResponsesRequest,
    request: Request,
    authorization: Optional[str] = Header(default=None),
    x_fingerprint: Optional[str] = Header(default=None),
):
    if SETTINGS is None:
        raise HTTPException(status_code=500, detail={"error": "Server not initialized"})

    resolved_site = resolve_auth_site(SETTINGS, request_body.site)

    token = validate_token(SETTINGS, authorization, resolved_site)
    if token is None:
        raise HTTPException(status_code=403, detail={"error": "Invalid or expired token"})

    prompt = request_body.input.strip()
    if not prompt:
        raise HTTPException(status_code=400, detail={"error": "Parameter input cannot be empty"})

    appname = normalize_optional_string(request_body.appname)
    site_settings = getattr(SETTINGS, resolved_site)
    default_site_settings = getattr(SETTINGS, "default")

    def get_site_config_value(key: str) -> Any:
        site_value = getattr(site_settings, key, None)
        if site_value is not None:
            return site_value
        return getattr(default_site_settings, key, None)

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
        SETTINGS,
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
        finish_prompt_error(SETTINGS, prompt_id, str(exc))
        raise HTTPException(status_code=500, detail={"error": str(exc)}) from exc

    used_tool = extract_used_tool_name(response_payload)
    if used_tool:
        update_prompt_tool(SETTINGS, prompt_id, used_tool)

    final_text = extract_final_assistant_completed_text(response_payload)
    finish_prompt_success(SETTINGS, prompt_id, final_text)

    return JSONResponse(content=response_payload)


# ================ Endpoints: Health =================

@app.get("/health")
async def health():
    return {"ok": True}


@app.get("/")
async def root():
    return {"service": "litellm-backend"}

