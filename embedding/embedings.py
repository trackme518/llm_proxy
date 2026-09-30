from fastapi.middleware.cors import CORSMiddleware
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import List, Union, Literal
from sentence_transformers import SentenceTransformer
import torch
import psutil
import threading
import time
# importing os module for environment variables
import os
# importing necessary functions from dotenv library
from dotenv import load_dotenv, dotenv_values 
from huggingface_hub import login
import pymupdf
import pymupdf4llm
import logging


def read_secret_or_env(name: str) -> str | None:
    file_path = os.getenv(f"{name}_FILE")
    if file_path:
        with open(file_path, "r", encoding="utf-8") as secret_file:
            return secret_file.read().strip()
    return os.getenv(name)

# loading variables from .env file
load_dotenv()
PYTHON_PORT = int(os.getenv("PYTHON_PORT", "8000"))
PYTHON_HOST = os.getenv("PYTHON_HOST", "0.0.0.0")
EMBEDDINGS_MODEL = os.getenv("EMBEDDINGS_MODEL")
EMBEDDINGS_MODEL_ID = EMBEDDINGS_MODEL or "local-embedding-model"
LOAD_LOCAL_EMBEDDING = os.getenv("LOAD_LOCAL_EMBEDDING", "true").lower() == "true"
HF_TOKEN = read_secret_or_env("HF_TOKEN")
# // will cast to integer - integer division
REQUEST_TIMEOUT = max(1, int(os.getenv("REQUEST_TIMEOUT", "60000")) // 1000)
# Check GPU availability once
HAS_CUDA = torch.cuda.is_available()
# Local model cache directory
MODELS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".", "models"))
os.makedirs(MODELS_DIR, exist_ok=True)


# -----------------------------
# Decide model source
if LOAD_LOCAL_EMBEDDING:
    print("Loading model from local cache folder...")
    EMBEDDINGS_MODEL = MODELS_DIR  # local folder
else:
    print(f"Loading model from Hugging Face: {EMBEDDINGS_MODEL}")
    if HF_TOKEN:
        login(token=HF_TOKEN, add_to_git_credential=False)
        print("Logged in to Hugging Face successfully.")
    else:
        print("Warning: HF_TOKEN is not set. Gated models will fail with 401.")

# Global request counter
active_requests = 0
requests_lock = threading.Lock()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("embedings")

# -----------------------------
app = FastAPI(title="Embeddings API")


@app.exception_handler(HTTPException)
async def http_exception_handler(request, exc: HTTPException):
    detail = exc.detail
    if isinstance(detail, dict):
        payload = detail
    else:
        payload = {"error": str(detail), "code": "http_error"}
    return JSONResponse(status_code=exc.status_code, content=payload)


@app.exception_handler(Exception)
async def generic_exception_handler(request, exc: Exception):
    print(f"Unhandled server error: {exc}")
    return JSONResponse(
        status_code=500,
        content={"error": "Internal server error", "code": "internal_error"},
    )

# Enable CORS for all origins (for local testing)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1", "http://localhost"],  # local only
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Force CPU mode (even if GPU is available)
#HAS_CUDA = False

def getModelParams(embed_model):
    try:
        embedding_dim = embed_model.get_embedding_dimension()
        print(f"Embedding dimension: {embedding_dim}")
        return embedding_dim
    except Exception as e:
        print(f"Failed to read embedding dimension: {e}")
        return None

# Load model based on context:
# - When imported by gunicorn workers (CPU): __name__ != "__main__"
# - When run directly with uvicorn (GPU): __name__ == "__main__" and HAS_CUDA
if __name__ != "__main__" or HAS_CUDA:
    print("Loading embedding model...")
    embed_model = SentenceTransformer(EMBEDDINGS_MODEL, cache_folder=MODELS_DIR)
    device = "cuda" if HAS_CUDA else "cpu"
    try:
        embed_model = embed_model.to(device)
        print(f"Using device: {device}")
        getModelParams(embed_model)
    except Exception as e:
        print(f"Failed to move model to {device}: {e}")
        print("Falling back to CPU")
        device = "cpu"
        embed_model = embed_model.to(device)
        getModelParams(embed_model)
else:
    embed_model = None
    device = None
# -----------------------------
# Request models
# -----------------------------
class EmbedRequest(BaseModel):
    model: str
    input: Union[str, List[str]]
    encoding_format: Literal["float"] = "float"


@app.get("/v1/models")
def list_models():
    return {"object": "list", "data": [{
        "id": EMBEDDINGS_MODEL_ID, "object": "model", "created": 0,
        "owned_by": "local", "type": "embedding",
    }]}


def _is_pdf_bytes(data: bytes) -> bool:
    return len(data) >= 5 and data[:5] == b"%PDF-"


@app.post("/extract-markdown")
async def extract_markdown(file: UploadFile = File(...)):
    started_at = time.time()
    filename = (file.filename or "").strip()
    content_type = (file.content_type or "").lower()

    logger.info("/extract-markdown request received file=%s content_type=%s", filename or "<empty>", content_type or "<empty>")

    if not filename and content_type != "application/pdf":
        raise HTTPException(status_code=400, detail={"error": "PDF file is required", "code": "missing_file"})

    if filename and not filename.lower().endswith(".pdf") and content_type != "application/pdf":
        raise HTTPException(status_code=400, detail={"error": "Only PDF files are supported", "code": "invalid_file_type"})

    pdf_bytes = await file.read()
    if not pdf_bytes:
        raise HTTPException(status_code=400, detail={"error": "Uploaded file is empty", "code": "empty_file"})

    logger.info("/extract-markdown validated file=%s bytes=%s", filename or "document.pdf", len(pdf_bytes))

    if not _is_pdf_bytes(pdf_bytes):
        raise HTTPException(status_code=400, detail={"error": "Invalid PDF file", "code": "invalid_pdf"})

    try:
        doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    except Exception as exc:
        raise HTTPException(
            status_code=400,
            detail={"error": "Failed to open PDF", "code": "pdf_open_failed", "detail": str(exc)},
        )

    try:
        md_text = pymupdf4llm.to_markdown(
            doc,
            use_ocr=False,
            force_ocr=False,
            ignore_images=True,
            write_images=False,
            embed_images=False,
        )
    except Exception as exc:
        raise HTTPException(
            status_code=422,
            detail={"error": "Failed to extract markdown", "code": "markdown_extract_failed", "detail": str(exc)},
        )
    finally:
        doc.close()

    if isinstance(md_text, list):
        md_text = "\n\n".join(
            item.get("text", "") if isinstance(item, dict) else str(item)
            for item in md_text
        ).strip()

    if not isinstance(md_text, str):
        md_text = str(md_text)

    elapsed_ms = int((time.time() - started_at) * 1000)
    logger.info("/extract-markdown completed file=%s markdown_chars=%s elapsed_ms=%s", filename or "document.pdf", len(md_text), elapsed_ms)

    return {"markdown": md_text}


# -----------------------------
# Embedding Endpoint
# -----------------------------
@app.post("/v1/embeddings")
def embed(request: EmbedRequest):
    global active_requests
    if request.model != EMBEDDINGS_MODEL_ID:
        raise HTTPException(status_code=404, detail="Unknown embedding model")
    inputs = request.input if isinstance(request.input, list) else [request.input]
    if not inputs or any(not text.strip() for text in inputs):
        raise HTTPException(status_code=400, detail="Input must contain non-empty text")
    
    with requests_lock:
        active_requests += 1
    
    try:
        # Clear GPU cache before embedding for stability
        if HAS_CUDA:
            try:
                torch.cuda.empty_cache()
                torch.cuda.synchronize()
            except Exception as e:
                print(f"Warning: CUDA operations failed: {e}")
        
        # Encode with error handling
        try:
            vectors = embed_model.encode(inputs, convert_to_numpy=True, batch_size=32)
        except RuntimeError as e:
            # GPU out of memory - fallback to CPU
            if "CUDA" in str(e) or "out of memory" in str(e).lower():
                print(f"GPU error: {e}")
                print("Falling back to CPU inference")
                embed_model.to("cpu")
                vectors = embed_model.encode(inputs, convert_to_numpy=True, batch_size=16)
                embed_model.to("cuda" if HAS_CUDA else "cpu")
            else:
                raise
        
        vectors_list = vectors.tolist()
        # Designed to be compatible with OpenAI format, does not include "usage"
        # https://platform.openai.com/docs/api-reference/embeddings/create
        return {
            "object": "list",
            "data": [
                {
                    "object": "embedding",
                    "embedding": emb,
                    "index": i
                }
                for i, emb in enumerate(vectors_list)
            ],
            "model": EMBEDDINGS_MODEL_ID
        }
    
    except Exception as e:
        print(f"Error in embedding: {e}")
        raise
    
    finally:
        with requests_lock:
            active_requests = max(0, active_requests - 1)
    
# -----------------------------
# Metrics endpoint
# -----------------------------
@app.get("/metrics")
def get_metrics():
    """Return current service metrics"""
    process = psutil.Process()
    return {
        "active_requests": active_requests,
        "cpu_percent": process.cpu_percent(),
        "memory_mb": process.memory_info().rss / 1024 / 1024,
        "timestamp": time.time()
    }

# Start server
if __name__ == "__main__":
    import signal
    import sys
    import os

    def handler(sig, frame):
        print("Shutting down...")
        sys.exit(0)

    signal.signal(signal.SIGINT, handler)
    os.chdir(os.path.dirname(os.path.abspath(__file__)))

    if HAS_CUDA:
        import uvicorn
        uvicorn.run(app, host=PYTHON_HOST, port=PYTHON_PORT, workers=1, log_level="info")
    else:
        os.execvp("gunicorn", [
            "gunicorn",
            "embedings:app",
            "--workers", "2",
            "--worker-class", "uvicorn.workers.UvicornWorker",
            "--preload",
            "--bind", f"{PYTHON_HOST}:{PYTHON_PORT}",
            "--log-level", "info",
            "--timeout", str(REQUEST_TIMEOUT),
            "--access-logfile", "-"
        ])
