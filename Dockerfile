# syntax=docker/dockerfile:1

############################
# Shared Python base
############################
FROM python:3.11-slim AS python-base
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     ca-certificates \
     libgomp1 \
  && rm -rf /var/lib/apt/lists/*

############################
# Embedding image (target: embedding-runtime)
############################
FROM python-base AS embedding-deps
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

RUN pip install --no-cache-dir --upgrade pip \
  && pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu \
  && pip install --no-cache-dir fastapi uvicorn gunicorn pydantic sentence-transformers python-dotenv psutil python-multipart pymupdf4llm huggingface_hub

FROM python-base AS embedding-runtime
ENV PATH="/opt/venv/bin:$PATH"
WORKDIR /app

COPY --from=embedding-deps /opt/venv /opt/venv
RUN mkdir -p /app/embedding /app/models
COPY embedding/embedings.py /app/embedding/embedings.py
COPY docker/entrypoint-python.sh /entrypoint-python.sh
RUN chmod +x /entrypoint-python.sh
WORKDIR /app/embedding
EXPOSE 8000
ENTRYPOINT ["/entrypoint-python.sh"]

############################
# Crawler image (target: crawler-runtime)
############################
FROM python-base AS crawler-deps
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     build-essential \
     curl \
     pkg-config \
     libssl-dev \
  && rm -rf /var/lib/apt/lists/*

RUN curl https://sh.rustup.rs -sSf | sh -s -- -y --profile minimal --default-toolchain 1.86.0
ENV PATH="/root/.cargo/bin:/opt/venv/bin:$PATH"

RUN pip install --no-cache-dir --upgrade pip setuptools wheel

RUN pip install --no-cache-dir \
  fastapi \
  uvicorn \
  gunicorn \
  pydantic \
  requests \
  scrapy \
  rs-trafilatura \
  spacy \
  networkx \
  langdetect \
  beautifulsoup4 \
  fake-useragent

RUN pip install --no-cache-dir cs-core-news-sm

RUN python -m spacy download xx_ent_wiki_sm \
  && python -m spacy download en_core_web_sm \
  && python -m spacy download de_core_news_sm \
  && python -m spacy download fr_core_news_sm \
  && python -m spacy download es_core_news_sm \
  && python -m spacy download it_core_news_sm \
  && python -m spacy download pl_core_news_sm \
  && python -c "import cs_core_news_sm; cs_core_news_sm.load()"

FROM python-base AS crawler-runtime
ENV PATH="/opt/venv/bin:$PATH"
WORKDIR /app

COPY --from=crawler-deps /opt/venv /opt/venv
RUN mkdir -p /app/crawler
COPY crawler_service/main.py /app/crawler/main.py
COPY crawler_service/scrapy_worker.py /app/crawler/scrapy_worker.py
COPY crawler_service/tf-idf.py /app/crawler/tf-idf.py
COPY crawler_service/sitemap_utils.py /app/crawler/sitemap_utils.py
COPY docker/entrypoint-crawler.sh /entrypoint-crawler.sh
RUN chmod +x /entrypoint-crawler.sh
WORKDIR /app/crawler
EXPOSE 11235
ENTRYPOINT ["/entrypoint-crawler.sh"]

############################
# LiteLLM backend image (target: litellm-runtime)
############################
FROM python-base AS litellm-deps
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

RUN pip install --no-cache-dir --upgrade pip \
  && pip install --no-cache-dir "litellm>=1.83.0" fastapi uvicorn gunicorn pydantic python-dotenv pymysql orjson cryptography

FROM python-base AS litellm-runtime
ENV PATH="/opt/venv/bin:$PATH"
WORKDIR /app

COPY --from=litellm-deps /opt/venv /opt/venv
COPY litellm/main.py /app/litellm/main.py
COPY litellm/console /app/litellm/console
COPY docker/entrypoint-litellm.sh /entrypoint-litellm.sh
RUN chmod +x /entrypoint-litellm.sh
WORKDIR /app/litellm
EXPOSE 8001
ENTRYPOINT ["/entrypoint-litellm.sh"]

############################
# Bun image (target: bun-runtime)
############################
FROM oven/bun:1.2.15 AS bun-base
WORKDIR /app/bun_rag

FROM bun-base AS bun-deps
COPY bun_rag/package.json bun_rag/bun.lock ./
RUN bun install --frozen-lockfile

FROM bun-base AS bun-runtime
WORKDIR /app/bun_rag

COPY --from=bun-deps /app/bun_rag/node_modules ./node_modules
COPY bun_rag/package.json bun_rag/bun.lock ./
COPY bun_rag/tsconfig.json ./
COPY bun_rag/public ./public
COPY bun_rag/src ./src
COPY docker/entrypoint-bun.sh /entrypoint-bun.sh
RUN chmod +x /entrypoint-bun.sh
EXPOSE 3000
ENTRYPOINT ["/entrypoint-bun.sh"]

############################
# Nginx frontend image (target: nginx-runtime)
############################
FROM nginx:1.29-alpine AS nginx-runtime
COPY nginx/nginx-chatbot.conf /etc/nginx/conf.d/default.conf
COPY nginx/www /usr/share/nginx/html
EXPOSE 80

############################
# MariaDB image (target: mariadb-runtime)
############################
FROM mariadb:12.1.2 AS mariadb-runtime
EXPOSE 3306
