import math
from collections import Counter
from typing import Dict, Iterable, List


def _normalize_documents(documents: Iterable[Iterable[str]]) -> List[List[str]]:
    normalized: List[List[str]] = []
    for doc in documents:
        tokens = [token for token in doc if token]
        if tokens:
            normalized.append(tokens)
    return normalized


def compute_tfidf_scores(documents: Iterable[Iterable[str]]) -> Dict[str, float]:
    """
    Pure-Python TF-IDF score aggregation.

    documents: iterable of token lists (e.g. one list per sentence).
    returns: {token: aggregated_tfidf_score}
    """
    docs = _normalize_documents(documents)
    if not docs:
        return {}

    document_count = len(docs)
    doc_frequency: Counter[str] = Counter()
    term_counts: List[Counter[str]] = []

    for tokens in docs:
        counts = Counter(tokens)
        term_counts.append(counts)
        doc_frequency.update(counts.keys())

    scores: Dict[str, float] = {}

    for counts in term_counts:
        total_terms = sum(counts.values())
        if total_terms <= 0:
            continue

        for token, tf_count in counts.items():
            tf = tf_count / total_terms
            df = doc_frequency.get(token, 0)
            idf = math.log((1.0 + document_count) / (1.0 + df)) + 1.0
            scores[token] = scores.get(token, 0.0) + (tf * idf)

    return scores
