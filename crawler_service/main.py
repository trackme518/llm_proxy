import importlib.util
import json
import math
import os
import re
import subprocess
import sys
from collections import defaultdict
from email.utils import parsedate_to_datetime
from typing import Any, Literal, Optional
from urllib.parse import urljoin, urlparse

import networkx as nx
import requests
import rs_trafilatura
import spacy
from bs4 import BeautifulSoup
from fastapi import FastAPI, HTTPException
from langdetect import detect as detect_language
from pydantic import BaseModel, Field

from sitemap_utils import discover_sitemap_urls


WORKER_PATH = os.path.join(os.path.dirname(__file__), "scrapy_worker.py")
TFIDF_PATH = os.path.join(os.path.dirname(__file__), "tf-idf.py")


def _load_tfidf_module():
    spec = importlib.util.spec_from_file_location("tf_idf_module", TFIDF_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("Failed to load tf-idf.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_tfidf_module = _load_tfidf_module()
compute_tfidf_scores = _tfidf_module.compute_tfidf_scores


app = FastAPI(title="scrapy-trafilatura-crawler")


class CrawlRequest(BaseModel):
    url: Optional[str] = None
    urls: list[str] = Field(default_factory=list)
    scope: Literal["single_page", "whole_domain"] = "single_page"
    use_sitemap: bool = True
    max_urls: int = Field(default=200, ge=1, le=2000)
    max_depth: int = Field(default=3, ge=1, le=6)


class SitemapRequest(BaseModel):
    url: str
    max_urls: int = Field(default=400, ge=1, le=2000)


SPACY_MODEL_BY_LANG = {
    "en": "en_core_web_sm",
    "de": "de_core_news_sm",
    "fr": "fr_core_news_sm",
    "es": "es_core_news_sm",
    "it": "it_core_news_sm",
    "pl": "pl_core_news_sm",
    "cs": "cs_core_news_sm",
}

_SPACY_CACHE: dict[str, Any] = {}


def load_spacy_for_language(language_code: str):
    code = (language_code or "").lower().split("-")[0]
    preferred = SPACY_MODEL_BY_LANG.get(code, "xx_ent_wiki_sm")

    if preferred in _SPACY_CACHE:
        return _SPACY_CACHE[preferred]

    try:
        nlp = spacy.load(preferred)
    except Exception:
        if "xx_ent_wiki_sm" in _SPACY_CACHE:
            return _SPACY_CACHE["xx_ent_wiki_sm"]
        nlp = spacy.load("xx_ent_wiki_sm")

    _SPACY_CACHE[preferred] = nlp
    return nlp


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


def parse_language_tag(value: Optional[str]) -> Optional[str]:
    raw = (value or "").strip().replace("_", "-")
    if not raw:
        return None

    parts = [part for part in raw.split("-") if part]
    if not parts:
        return None

    primary = parts[0].lower()
    if not re.fullmatch(r"[a-z]{2,3}", primary):
        return None

    normalized = [primary]
    for part in parts[1:]:
        if re.fullmatch(r"[a-zA-Z]{4}", part):
            normalized.append(part.capitalize())
        elif re.fullmatch(r"[a-zA-Z]{2}", part) or re.fullmatch(r"\d{3}", part):
            normalized.append(part.upper())
        elif re.fullmatch(r"[a-zA-Z0-9]{5,8}", part):
            normalized.append(part.lower())

    return "-".join(normalized)


def language_primary(value: Optional[str]) -> Optional[str]:
    parsed = parse_language_tag(value)
    return parsed.split("-")[0] if parsed else None


def extract_html_lang(html: str) -> Optional[str]:
    match = re.search(r"<html\b[^>]*\blang\s*=\s*[\"']?([^\"'\s>]+)", html or "", flags=re.IGNORECASE)
    return parse_language_tag(match.group(1) if match else None)


def is_html_candidate(url: str) -> bool:
    path = urlparse(url).path.lower()
    blocked_extensions = (
        ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".zip", ".rar", ".7z", ".jpg", ".jpeg",
        ".png", ".gif", ".webp", ".svg", ".ico", ".mp4", ".mp3", ".avi", ".mov", ".xml", ".json", ".rss"
    )
    return not path.endswith(blocked_extensions)


def normalize_keywords(values: list[str], max_keywords: int = 10) -> list[str]:
    seen: set[str] = set()
    output: list[str] = []
    for value in values:
        for part in re.split(r"[,;|\n]+", value):
            candidate = part.strip().lower()
            if not candidate or len(candidate) > 120:
                continue
            if candidate in seen:
                continue
            seen.add(candidate)
            output.append(candidate)
            if len(output) >= max_keywords:
                return output
    return output


def extract_meta_keywords(html: str) -> list[str]:
    soup = BeautifulSoup(html, "html.parser")
    collected: list[str] = []
    for tag in soup.find_all("meta"):
        name = (tag.get("name") or tag.get("property") or "").strip().lower()
        if name not in {"keywords", "news_keywords", "article:tag", "og:keywords"}:
            continue
        content = tag.get("content")
        if isinstance(content, str) and content.strip():
            collected.append(content)
    return normalize_keywords(collected)


def min_max_normalize(scores: dict[str, float]) -> dict[str, float]:
    if not scores:
        return {}
    values = list(scores.values())
    min_val = min(values)
    max_val = max(values)
    if math.isclose(min_val, max_val):
        return {key: 1.0 for key in scores}
    denom = max_val - min_val
    return {key: (value - min_val) / denom for key, value in scores.items()}


def compute_textrank_scores(tokens: list[str], window_size: int = 4) -> dict[str, float]:
    if not tokens:
        return {}

    graph = nx.Graph()
    for token in tokens:
        if not graph.has_node(token):
            graph.add_node(token)

    token_count = len(tokens)
    for i in range(token_count):
        for j in range(i + 1, min(i + window_size, token_count)):
            left = tokens[i]
            right = tokens[j]
            if left == right:
                continue
            if graph.has_edge(left, right):
                graph[left][right]["weight"] += 1.0
            else:
                graph.add_edge(left, right, weight=1.0)

    if graph.number_of_nodes() == 0:
        return {}

    try:
        return nx.pagerank(graph, weight="weight")
    except Exception:
        return {}


def tfranked_keywords(text: str, title: str, language_hint: Optional[str], top_k: int = 4, alpha: float = 0.6) -> list[str]:
    if not text.strip():
        return []

    detected_lang = (language_hint or "").strip().lower()
    if not detected_lang:
        try:
            detected_lang = detect_language(text)
        except Exception:
            detected_lang = ""

    nlp = load_spacy_for_language(detected_lang)
    doc = nlp(text)

    pos_allowed = {"NOUN", "VERB", "PROPN"}
    token_stream: list[str] = []
    documents: list[list[str]] = []

    for sent in doc.sents:
        sent_tokens: list[str] = []
        for token in sent:
            if token.is_stop or token.is_punct or token.like_num:
                continue
            lemma = token.lemma_.strip().lower()
            if not lemma or not lemma.isalpha() or len(lemma) < 2:
                continue
            if token.pos_ and token.pos_ not in pos_allowed:
                continue
            token_stream.append(lemma)
            sent_tokens.append(lemma)
        if sent_tokens:
            documents.append(sent_tokens)

    if not token_stream:
        return []

    tfidf_raw = compute_tfidf_scores(documents)
    textrank_raw = compute_textrank_scores(token_stream)

    tfidf_norm = min_max_normalize(tfidf_raw)
    textrank_norm = min_max_normalize(textrank_raw)

    title_tokens = set()
    if title:
        title_doc = nlp(title)
        for token in title_doc:
            lemma = token.lemma_.strip().lower()
            if lemma and lemma.isalpha():
                title_tokens.add(lemma)

    ner_tokens: set[str] = set()
    if "ner" in nlp.pipe_names:
        for ent in doc.ents:
            for token in ent:
                lemma = token.lemma_.strip().lower()
                if lemma and lemma.isalpha():
                    ner_tokens.add(lemma)

    all_terms = set(tfidf_norm.keys()) | set(textrank_norm.keys())
    scores: dict[str, float] = {}

    for term in all_terms:
        base_score = (alpha * tfidf_norm.get(term, 0.0)) + ((1.0 - alpha) * textrank_norm.get(term, 0.0))
        title_weight = 2.0 if term in title_tokens else 1.0
        score = base_score * title_weight
        if term in ner_tokens:
            score *= 1.5
        scores[term] = score

    ranked = sorted(scores.items(), key=lambda pair: pair[1], reverse=True)
    keywords = [term for term, _ in ranked[:top_k]]

    for ner_term in sorted(ner_tokens):
        if len(keywords) >= top_k:
            break
        if ner_term not in keywords:
            keywords.append(ner_term)

    return keywords[:top_k]


def parse_last_modified(headers: dict[str, str]) -> Optional[str]:
    value = headers.get("last-modified")
    if not value:
        return None
    try:
        return parsedate_to_datetime(value).date().isoformat()
    except Exception:
        return value


def parse_extract_result(extract_result: Any) -> dict[str, Any]:
    output: dict[str, Any] = {}
    for key in [
        "title", "author", "date", "main_content", "content_markdown", "page_type",
        "extraction_quality", "classification_confidence", "language", "sitename", "description"
    ]:
        output[key] = getattr(extract_result, key, None)
    return output


def parse_worker_payload(stdout: str, stderr: str) -> dict[str, Any]:
    text = (stdout or "").strip()
    if not text:
        return {"pages": [], "errors": [{"error": "empty-worker-stdout"}]}

    try:
        return json.loads(text)
    except json.JSONDecodeError:
        # Defensive fallback: tolerate worker logs before/after JSON payload.
        pass

    for line in reversed(text.splitlines()):
        candidate = line.strip()
        if not candidate:
            continue
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            continue

    raise RuntimeError(f"scrapy worker returned invalid JSON; stdout={text[:1000]!r}; stderr={stderr[:1000]!r}")


def run_scrapy_fetch(urls: list[str]) -> dict[str, Any]:
    process = subprocess.run(
        [sys.executable, WORKER_PATH],
        input=json.dumps({"mode": "fetch_urls", "urls": urls}),
        text=True,
        capture_output=True,
        check=False,
        timeout=180,
    )

    payload = parse_worker_payload(process.stdout, process.stderr)

    if process.returncode != 0:
        raise RuntimeError(f"scrapy worker failed: {payload}")

    return payload


def run_scrapy_domain(seed_url: str, max_urls: int, max_depth: int) -> dict[str, Any]:
    process = subprocess.run(
        [sys.executable, WORKER_PATH],
        input=json.dumps(
            {
                "mode": "crawl_domain",
                "seed_url": seed_url,
                "max_urls": max_urls,
                "max_depth": max_depth,
            }
        ),
        text=True,
        capture_output=True,
        check=False,
        timeout=300,
    )

    payload = parse_worker_payload(process.stdout, process.stderr)

    if process.returncode != 0:
        raise RuntimeError(f"scrapy worker failed: {payload}")

    return payload


def extract_results_from_pages(pages: list[dict[str, Any]], homepage_url: Optional[str] = None) -> list[dict[str, Any]]:
    extracted_pages: list[dict[str, Any]] = []

    for page in pages:
        html = str(page.get("html") or "")
        page_url = normalize_url(str(page.get("url") or "")) if page.get("url") else ""
        headers = page.get("headers") if isinstance(page.get("headers"), dict) else {}
        header_map = {str(k).lower(): str(v) for k, v in headers.items()}

        if not html.strip() or not page_url:
            continue

        extraction = rs_trafilatura.extract(
            html,
            url=page_url,
            output_markdown=True,
            include_tables=True,
            include_images=False,
            include_comments=False,
        )

        extraction_data = parse_extract_result(extraction)
        markdown = extraction_data.get("content_markdown") or rs_trafilatura.html_to_markdown(html)

        extraction_language = parse_language_tag(extraction_data.get("language"))
        html_language = extract_html_lang(html)
        language_defined = extraction_language or html_language

        title = str(extraction_data.get("title") or "").strip()
        main_content = str(extraction_data.get("main_content") or "")

        meta_keywords = extract_meta_keywords(html)
        keywords = meta_keywords if meta_keywords else tfranked_keywords(main_content, title, language_defined, top_k=4)

        extracted_date = extraction_data.get("date")
        last_modified = parse_last_modified(header_map)
        final_date = extracted_date or last_modified

        metadata = {
            "title": title or None,
            "author": extraction_data.get("author"),
            "date": final_date,
            "description": extraction_data.get("description"),
            "keywords": keywords,
            "language": language_defined,
            "last_modified": last_modified,
        }

        extracted_pages.append(
            {
                "success": True,
                "url": page_url,
                "html": html,
                "markdown": {"fit_markdown": markdown or main_content},
                "metadata": metadata,
                "links": {"internal": []},
                "language_defined": language_defined,
                "canonical_url": canonicalize_url(page_url),
            }
        )

    homepage_canonical = canonicalize_url(homepage_url) if homepage_url else None
    homepage_language_primary: Optional[str] = None

    if homepage_canonical:
        for page in extracted_pages:
            if page.get("canonical_url") != homepage_canonical:
                continue
            homepage_language_primary = language_primary(page.get("language_defined"))
            if homepage_language_primary:
                break

    results: list[dict[str, Any]] = []
    for page in extracted_pages:
        if homepage_language_primary:
            page_language_primary = language_primary(page.get("language_defined"))
            if page_language_primary and page_language_primary != homepage_language_primary:
                continue

        page.pop("language_defined", None)
        page.pop("canonical_url", None)
        results.append(page)

    return results


@app.post("/sitemap")
def sitemap(request: SitemapRequest):
    try:
        urls = discover_sitemap_urls(request.url, request.max_urls)
        return {"urls": urls}
    except Exception as exc:
        raise HTTPException(status_code=500, detail={"error": str(exc)}) from exc


@app.post("/crawl")
def crawl(request: CrawlRequest):
    if request.scope == "single_page":
        source_urls = [request.url] if request.url else request.urls
        urls = [normalize_url(str(url)) for url in source_urls if str(url).strip()]
        urls = [url for url in urls if is_html_candidate(url)]
        if not urls:
            return {"results": []}

        try:
            worker_payload = run_scrapy_fetch(urls[: request.max_urls])
        except Exception as exc:
            raise HTTPException(status_code=500, detail={"error": str(exc)}) from exc

        pages = worker_payload.get("pages") if isinstance(worker_payload, dict) else []
        if not isinstance(pages, list):
            pages = []

        return {"results": extract_results_from_pages(pages)}

    seed_url = normalize_url(request.url or "") if request.url else ""
    if not seed_url:
        raise HTTPException(status_code=400, detail={"error": "url is required for whole_domain scope"})

    parsed_seed = urlparse(seed_url)
    homepage_url = normalize_url(urljoin(f"{parsed_seed.scheme}://{parsed_seed.netloc}", "/"))

    pages: list[dict[str, Any]] = []

    if request.use_sitemap:
        try:
            sitemap_urls = discover_sitemap_urls(seed_url, request.max_urls)
        except Exception:
            sitemap_urls = []
    else:
        sitemap_urls = []

    if sitemap_urls:
        deduped_urls: list[str] = []
        seen: set[str] = set()

        for url in [homepage_url, *sitemap_urls]:
            normalized = normalize_url(url)
            if not is_html_candidate(normalized):
                continue
            try:
                key = canonicalize_url(normalized)
            except Exception:
                continue
            if key in seen:
                continue
            seen.add(key)
            deduped_urls.append(normalized)
            if len(deduped_urls) >= request.max_urls:
                break

        try:
            worker_payload = run_scrapy_fetch(deduped_urls)
        except Exception as exc:
            raise HTTPException(status_code=500, detail={"error": str(exc)}) from exc

        pages_payload = worker_payload.get("pages") if isinstance(worker_payload, dict) else []
        pages = pages_payload if isinstance(pages_payload, list) else []
    else:
        try:
            worker_payload = run_scrapy_domain(seed_url, request.max_urls, request.max_depth)
        except Exception as exc:
            raise HTTPException(status_code=500, detail={"error": str(exc)}) from exc

        pages_payload = worker_payload.get("pages") if isinstance(worker_payload, dict) else []
        pages = pages_payload if isinstance(pages_payload, list) else []

    return {"results": extract_results_from_pages(pages, homepage_url=homepage_url)}


@app.get("/health")
def health():
    return {"ok": True}
