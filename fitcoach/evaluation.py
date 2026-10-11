"""Retrieval and LLM-judged generation evaluation."""

import json
from pathlib import Path

import requests
from sentence_transformers import SentenceTransformer

from .config import DEFAULT_LLM_MODEL, EMBEDDING_MODEL_NAME, OLLAMA_BASE_URL
from .generation import generate_grounded_answer
from .models import InMemoryVectorStore, SearchResult
from .retrieval import retrieve_hybrid


def retrieval_metrics(
    retrieved_document_ids: list[str], relevant_document_ids: list[str]
) -> tuple[float, float]:
    relevant = set(relevant_document_ids)
    for rank, document_id in enumerate(retrieved_document_ids, start=1):
        if document_id in relevant:
            return 1.0, 1.0 / rank
    return 0.0, 0.0


def judge_rag_quality(
    query: str,
    answer: str,
    results: list[SearchResult],
    model_name: str = DEFAULT_LLM_MODEL,
) -> dict[str, float]:
    context = "\n\n".join(
        f"[S{index}] {chunk.text}"
        for index, (chunk, _) in enumerate(results, start=1)
    )
    judge_prompt = f"""
Score this RAG result using numbers from 0.0 to 1.0.

- faithfulness: Are all claims in the answer supported by the context?
- answer_relevance: Does the answer directly and usefully answer the question?
- context_relevance: Is the retrieved context useful for answering the question?

Question:
{query}

Retrieved context:
{context}

Answer:
{answer}

Return only a JSON object with exactly these numeric keys:
faithfulness, answer_relevance, context_relevance
""".strip()
    response = requests.post(
        f"{OLLAMA_BASE_URL}/api/chat",
        json={
            "model": model_name,
            "stream": False,
            "format": "json",
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "You are a strict RAG evaluator. Score only the supplied "
                        "question, context, and answer."
                    ),
                },
                {"role": "user", "content": judge_prompt},
            ],
            "options": {"temperature": 0},
        },
        timeout=120,
    )
    response.raise_for_status()
    raw_scores = json.loads(response.json()["message"]["content"])
    return {
        metric: max(0.0, min(1.0, float(raw_scores[metric])))
        for metric in ("faithfulness", "answer_relevance", "context_relevance")
    }


def run_evaluation(
    vector_store: InMemoryVectorStore,
    embedding_model: SentenceTransformer,
    dataset_path: Path,
    output_path: Path,
    top_k: int = 5,
    model_name: str = DEFAULT_LLM_MODEL,
) -> dict:
    dataset = json.loads(dataset_path.read_text(encoding="utf-8"))
    records = []
    print("\nRunning evaluation")
    print("=" * 60)
    for index, item in enumerate(dataset, start=1):
        question = item["question"]
        retrieved = retrieve_hybrid(
            question, vector_store, embedding_model, top_k
        )
        answer = generate_grounded_answer(question, retrieved, model_name)
        retrieved_ids = [chunk.document_id for chunk, _ in retrieved]
        hit_rate, mrr = retrieval_metrics(
            retrieved_ids, item["relevant_document_ids"]
        )
        judged = judge_rag_quality(question, answer, retrieved, model_name)
        record = {
            "id": item["id"],
            "question": question,
            "relevant_document_ids": item["relevant_document_ids"],
            "retrieved_chunk_ids": [chunk.chunk_id for chunk, _ in retrieved],
            "retrieved_document_ids": retrieved_ids,
            "answer": answer,
            "hit_rate_at_k": hit_rate,
            "mrr": mrr,
            **judged,
        }
        records.append(record)
        print(
            f"[{index}/{len(dataset)}] {item['id']}: "
            f"Hit={hit_rate:.0f} MRR={mrr:.3f} "
            f"Faith={judged['faithfulness']:.2f} "
            f"AnswerRel={judged['answer_relevance']:.2f} "
            f"ContextRel={judged['context_relevance']:.2f}"
        )

    metric_names = (
        "hit_rate_at_k",
        "mrr",
        "faithfulness",
        "answer_relevance",
        "context_relevance",
    )
    aggregate = {
        metric: sum(record[metric] for record in records) / len(records)
        for metric in metric_names
    }
    report = {
        "configuration": {
            "retrieval": "hybrid (dense + BM25 with reciprocal rank fusion)",
            "top_k": top_k,
            "embedding_model": EMBEDDING_MODEL_NAME,
            "generation_and_judge_model": model_name,
            "question_count": len(records),
        },
        "aggregate": aggregate,
        "results": records,
    }
    output_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print("\nAggregate evaluation results")
    print("=" * 60)
    for metric, score in aggregate.items():
        print(f"{metric}: {score:.3f}")
    print(f"Detailed results saved to: {output_path}")
    return report
