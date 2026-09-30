import json
import re
import sys
from typing import Any, Optional
from urllib.parse import urldefrag, urljoin, urlparse

import scrapy
from fake_useragent import UserAgent
from scrapy.crawler import CrawlerProcess

DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36"

PROCESS_SETTINGS = {
    "LOG_ENABLED": False,
    "REDIRECT_ENABLED": True,
    "COOKIES_ENABLED": False,
    "ROBOTSTXT_OBEY": False,
    "DOWNLOAD_TIMEOUT": 30,
    "USER_AGENT": DEFAULT_USER_AGENT,
    "CONCURRENT_REQUESTS": 16,
    "HTTPERROR_ALLOW_ALL": True,
}

try:
    USER_AGENT_PROVIDER = UserAgent()
except Exception:
    USER_AGENT_PROVIDER = None


def random_user_agent() -> str:
    if USER_AGENT_PROVIDER is None:
        return DEFAULT_USER_AGENT
    try:
        return str(USER_AGENT_PROVIDER.random or DEFAULT_USER_AGENT)
    except Exception:
        return DEFAULT_USER_AGENT

# Scrapy 2.13+ prefers `start()` over `start_requests()`. Keep both for compatibility.
USE_ASYNC_START = hasattr(scrapy.Spider, "start")

RESULTS: list[dict[str, Any]] = []
ERRORS: list[dict[str, Any]] = []


def is_html_candidate(url: str) -> bool:
    path = urlparse(url).path.lower()
    blocked_extensions = (
        ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".zip", ".rar", ".7z", ".jpg", ".jpeg",
        ".png", ".gif", ".webp", ".svg", ".ico", ".mp4", ".mp3", ".avi", ".mov", ".xml", ".json", ".rss"
    )
    return not path.endswith(blocked_extensions)


def normalize_url(value: str) -> str:
    parsed = urlparse(value.strip())
    if not parsed.scheme:
        return f"https://{value.strip()}"
    return value.strip()


def canonicalize_url(value: str) -> str:
    parsed = urlparse(normalize_url(value))
    path = parsed.path or "/"
    if len(path) > 1:
        path = path.rstrip("/")
    return parsed._replace(scheme=parsed.scheme.lower(), netloc=parsed.netloc.lower(), path=path, fragment="").geturl()


def extract_html_lang(html: str) -> Optional[str]:
    match = re.search(r"<html\b[^>]*\blang\s*=\s*[\"']?([^\"'\s>]+)", html or "", flags=re.IGNORECASE)
    return (match.group(1).strip() if match else None) or None


def extract_headers(response: scrapy.http.Response) -> dict[str, str]:
    headers: dict[str, str] = {}
    for key in response.headers.keys():
        key_str = key.decode("utf-8", errors="ignore").lower() if isinstance(key, (bytes, bytearray)) else str(key).lower()
        values = response.headers.getlist(key)
        value_parts: list[str] = []
        for value in values:
            if isinstance(value, (bytes, bytearray)):
                value_parts.append(value.decode("utf-8", errors="ignore"))
            else:
                value_parts.append(str(value))
        headers[key_str] = ", ".join(value_parts)
    return headers


class HtmlSpider(scrapy.Spider):
    name = "html_spider"

    custom_settings = PROCESS_SETTINGS

    def __init__(
        self,
        mode: str,
        urls: Optional[list[str]] = None,
        seed_url: Optional[str] = None,
        max_urls: int = 200,
        max_depth: int = 3,
        *args,
        **kwargs,
    ):
        super().__init__(*args, **kwargs)
        self._mode = mode
        self._urls = [normalize_url(url) for url in (urls or []) if str(url).strip()]
        self._seed_url = normalize_url(seed_url) if seed_url else None
        self._max_urls = max_urls
        self._max_depth = max_depth

        self._allowed_host = None
        self._visited: set[str] = set()
        self._queued: set[str] = set()

        if self._mode == "crawl_domain" and self._seed_url:
            parsed = urlparse(self._seed_url)
            self._allowed_host = parsed.netloc.lower()

    def _iter_initial_requests(self):
        if self._mode == "crawl_domain" and self._seed_url:
            seed_parsed = urlparse(self._seed_url)
            homepage = normalize_url(urljoin(f"{seed_parsed.scheme}://{seed_parsed.netloc}", "/"))
            self._queued.add(canonicalize_url(homepage))
            yield scrapy.Request(
                url=homepage,
                callback=self.parse,
                errback=self.on_error,
                dont_filter=True,
                headers={"User-Agent": random_user_agent()},
                meta={"depth_level": 0, "dont_merge_cookies": True},
            )
            return

        for url in self._urls:
            try:
                key = canonicalize_url(url)
            except Exception:
                continue
            if key in self._queued:
                continue
            self._queued.add(key)
            yield scrapy.Request(
                url=url,
                callback=self.parse,
                errback=self.on_error,
                dont_filter=True,
                headers={"User-Agent": random_user_agent()},
                meta={"depth_level": 0, "dont_merge_cookies": True},
            )

    if USE_ASYNC_START:

        async def start(self):
            for request in self._iter_initial_requests():
                yield request

    def start_requests(self):
        yield from self._iter_initial_requests()

    def parse(self, response: scrapy.http.Response):
        content_type = response.headers.get("Content-Type", b"").decode("utf-8", errors="ignore").lower()
        if "text/html" not in content_type and "application/xhtml+xml" not in content_type:
            return

        try:
            canonical = canonicalize_url(response.url)
        except Exception:
            return

        if canonical in self._visited:
            return
        self._visited.add(canonical)

        try:
            RESULTS.append(
                {
                    "url": response.url,
                    "status": int(response.status),
                    "headers": extract_headers(response),
                    "html": response.text,
                    "html_lang": extract_html_lang(response.text),
                }
            )
        except Exception as exc:
            ERRORS.append({"url": response.url, "error": f"parse-failed: {exc}"})
            return

        if self._mode != "crawl_domain":
            return

        if len(RESULTS) >= self._max_urls:
            return

        current_depth = int(response.meta.get("depth_level", 0) or 0)
        if current_depth >= self._max_depth:
            return

        for href in response.css("a::attr(href)").getall():
            absolute = normalize_url(urljoin(response.url, href.strip()))
            absolute, _ = urldefrag(absolute)

            parsed = urlparse(absolute)
            if parsed.scheme not in {"http", "https"}:
                continue
            if self._allowed_host and parsed.netloc.lower() != self._allowed_host:
                continue
            if not is_html_candidate(absolute):
                continue

            try:
                key = canonicalize_url(absolute)
            except Exception:
                continue

            if key in self._visited or key in self._queued:
                continue

            if len(self._queued) >= self._max_urls * 4:
                continue

            self._queued.add(key)
            yield scrapy.Request(
                url=absolute,
                callback=self.parse,
                errback=self.on_error,
                dont_filter=True,
                headers={"User-Agent": random_user_agent()},
                meta={"depth_level": current_depth + 1, "dont_merge_cookies": True},
            )

    def on_error(self, failure):
        request = getattr(failure, "request", None)
        ERRORS.append(
            {
                "url": getattr(request, "url", None),
                "error": str(failure.value) if getattr(failure, "value", None) else str(failure),
            }
        )


def main() -> int:
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError as exc:
        print(json.dumps({"pages": [], "errors": [{"error": f"invalid-json: {exc}"}]}))
        return 1

    mode = str(payload.get("mode") or "fetch_urls")

    if mode == "crawl_domain":
        seed_url = payload.get("seed_url")
        if not isinstance(seed_url, str) or not seed_url.strip():
            print(json.dumps({"pages": [], "errors": [{"error": "seed_url must be provided for crawl_domain mode"}]}))
            return 1

        max_urls = int(payload.get("max_urls") or 200)
        max_depth = int(payload.get("max_depth") or 3)

        process = CrawlerProcess(settings=PROCESS_SETTINGS, install_root_handler=False)
        process.crawl(HtmlSpider, mode="crawl_domain", seed_url=seed_url.strip(), max_urls=max_urls, max_depth=max_depth)
        process.start()

        print(json.dumps({"pages": RESULTS[:max_urls], "errors": ERRORS}))
        return 0

    urls = payload.get("urls")
    if not isinstance(urls, list):
        print(json.dumps({"pages": [], "errors": [{"error": "urls must be a list"}]}))
        return 1

    normalized_urls = [str(url).strip() for url in urls if str(url).strip()]
    if not normalized_urls:
        print(json.dumps({"pages": [], "errors": []}))
        return 0

    process = CrawlerProcess(settings=PROCESS_SETTINGS, install_root_handler=False)
    process.crawl(HtmlSpider, mode="fetch_urls", urls=normalized_urls)
    process.start()

    print(json.dumps({"pages": RESULTS, "errors": ERRORS}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
