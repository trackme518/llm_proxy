from fastapi.middleware.cors import CORSMiddleware
from fastapi import FastAPI
from pydantic import BaseModel
from typing import List
from sentence_transformers import SentenceTransformer
from transformers import AutoModelForSequenceClassification, AutoTokenizer
import torch
import numpy as np

app = FastAPI(title="Local HuggingFace API Simulator")

# Enable CORS for all origins (for local testing)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # allows all origins
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# -----------------------------
# Load models
# -----------------------------
print("Loading embedding model...")
embed_model = SentenceTransformer("Seznam/simcse-dist-mpnet-paracrawl-cs-en")
# alternative - better by JB? https://huggingface.co/intfloat/multilingual-e5-large

print("Loading reranker model...")
reranker_model_name = "cross-encoder/mmarco-mMiniLMv2-L12-H384-v1"
reranker_tokenizer = AutoTokenizer.from_pretrained(reranker_model_name)
reranker_model = AutoModelForSequenceClassification.from_pretrained(reranker_model_name)

device = "cuda" if torch.cuda.is_available() else "cpu"
reranker_model.to(device)

# -----------------------------
# Request models
# -----------------------------
class EmbedRequest(BaseModel):
    inputs: str

class RerankRequest(BaseModel):
    query: str
    passages: List[str]

# -----------------------------
# Embedding Endpoint
# -----------------------------
@app.post("/embed")
def embed(request: EmbedRequest):
    vector = embed_model.encode(request.inputs, convert_to_numpy=True).tolist()
    return [vector]

# -----------------------------
# Reranking Endpoint
# -----------------------------
@app.post("/rerank")
def rerank(request: RerankRequest):
    scores = []
    for passage in request.passages:
        inputs = reranker_tokenizer(request.query, passage, return_tensors="pt", truncation=True, padding=True).to(device)
        with torch.no_grad():
            output = reranker_model(**inputs)
            #score = torch.softmax(output.logits, dim=1)[0][1].item()  # assume index 1 = relevance
            score = torch.sigmoid(output.logits[0]).item() # mmarco-mMiniLMv2-L12-H384-v1 is single-logit regression model
        scores.append(score)
    return scores

# -----------------------------
# Run server
# -----------------------------
if __name__ == "__main__":
    import uvicorn
    import signal
    import sys

    def handler(sig, frame):
        print("Shutting down...")
        sys.exit(0)

    signal.signal(signal.SIGINT, handler)
    uvicorn.run(app, host="127.0.0.1", port=8000)
