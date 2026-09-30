from __future__ import annotations

from collections import deque
from typing import Optional
from urllib.parse import urldefrag, urljoin, urlparse

import requests
from bs4 import BeautifulSoup
from scrapy.utils.sitemap import Sitemap, sitemap_urls_from_robots


REQUEST_HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36"}


def normalize_url(value: str) -> str:
    parsed = urlparse(value.strip())
    if not parsed.scheme:
        return f"https://{value.strip()}"
    return value.strip()


def is_html_candidate(url: str) -> bool:
    path = urlparse(url).path.lower()
    blocked_extensions = (
        ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".zip", ".rar", ".7z", ".jpg", ".jpeg",
        ".png", ".gif", ".webp", ".svg", ".ico", ".mp4", ".mp3", ".avi", ".mov", ".xml", ".json", ".rss"
    )
    return not path.endswith(blocked_extensions)


def fetch_bytes(url: str, timeout_seconds: int = 20) -> tuple[Optional[bytes], str]:
    try:
        response = requests.get(url, timeout=timeout_seconds, headers=REQUEST_HEADERS)
    except Exception:
        return None, ""

    if response.status_code >= 400:
        return None, ""

    content_type = response.headers.get("content-type", "").lower()
    return response.content, content_type


def discover_sitemap_urls(seed_url: str, max_urls: int) -> list[str]:
    base_url = normalize_url(seed_url)
    parsed = urlparse(base_url)
    root = f"{parsed.scheme}://{parsed.netloc}"

    queue: deque[str] = deque([normalize_url(urljoin(root, "/sitemap.xml"))])
    visited_sitemaps: set[str] = set()
    collected_urls: list[str] = []
    seen_urls: set[str] = set()

    robots_bytes, _ = fetch_bytes(urljoin(root, "/robots.txt"))
    if robots_bytes:
        for sitemap_url in sitemap_urls_from_robots(robots_bytes, base_url=root):
            normalized = normalize_url(sitemap_url)
            if normalized not in visited_sitemaps:
                queue.append(normalized)

    while queue and len(collected_urls) < max_urls:
        current_sitemap = queue.popleft()
        if current_sitemap in visited_sitemaps:
            continue
        visited_sitemaps.add(current_sitemap)

        xml_bytes, content_type = fetch_bytes(current_sitemap)
        if not xml_bytes:
            continue

        if "xml" not in content_type and not xml_bytes.lstrip().startswith(b"<"):
            continue

        try:
            sitemap = Sitemap(xml_bytes)
        except Exception:
            continue

        for entry in sitemap:
            loc = str(entry.get("loc") or "").strip()
            if not loc:
                continue

            normalized_loc = normalize_url(loc)

            if sitemap.type == "sitemapindex":
                if normalized_loc not in visited_sitemaps:
                    queue.append(normalized_loc)
                continue

            if not is_html_candidate(normalized_loc):
                continue

            loc_host = urlparse(normalized_loc).netloc.lower()
            if loc_host != parsed.netloc.lower():
                continue

            if normalized_loc in seen_urls:
                continue

            seen_urls.add(normalized_loc)
            collected_urls.append(normalized_loc)

            if len(collected_urls) >= max_urls:
                break

    return collected_urls[:max_urls]


def discover_urls_from_homepage(seed_url: str, max_urls: int, max_depth: int = 3) -> list[str]:
    base_url = normalize_url(seed_url)
    parsed = urlparse(base_url)
    root = f"{parsed.scheme}://{parsed.netloc}"
    allowed_host = parsed.netloc.lower()

    homepage = normalize_url(urljoin(root, "/"))

    queue: deque[tuple[str, int]] = deque([(homepage, 0)])
    visited: set[str] = set()
    collected_urls: list[str] = []
    seen_urls: set[str] = set()

    while queue and len(collected_urls) < max_urls:
        current_url, depth = queue.popleft()
        current_url = normalize_url(current_url)

        if current_url in visited:
            continue
        visited.add(current_url)

        if not is_html_candidate(current_url):
            continue

        current_host = urlparse(current_url).netloc.lower()
        if current_host != allowed_host:
            continue

        if current_url not in seen_urls:
            seen_urls.add(current_url)
            collected_urls.append(current_url)
            if len(collected_urls) >= max_urls:
                break

        if depth >= max_depth:
            continue

        html_bytes, content_type = fetch_bytes(current_url)
        if not html_bytes:
            continue

        if "html" not in content_type and not html_bytes.lstrip().startswith(b"<"):
            continue

        try:
            html = html_bytes.decode("utf-8", errors="ignore")
            soup = BeautifulSoup(html, "html.parser")
        except Exception:
            continue

        for anchor in soup.find_all("a"):
            href = anchor.get("href")
            if not isinstance(href, str) or not href.strip():
                continue

            absolute = normalize_url(urljoin(current_url, href.strip()))
            absolute, _ = urldefrag(absolute)

            target_parsed = urlparse(absolute)
            if target_parsed.scheme not in {"http", "https"}:
                continue
            if target_parsed.netloc.lower() != allowed_host:
                continue
            if not is_html_candidate(absolute):
                continue
            if absolute in visited:
                continue

            queue.append((absolute, depth + 1))

    return collected_urls[:max_urls]


def discover_urls(seed_url: str, max_urls: int, fallback_depth: int = 3) -> list[str]:
    sitemap_urls = discover_sitemap_urls(seed_url, max_urls)
    if sitemap_urls:
        return sitemap_urls[:max_urls]

    return discover_urls_from_homepage(seed_url, max_urls, max_depth=fallback_depth)
