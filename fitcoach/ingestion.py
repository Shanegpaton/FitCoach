"""PDF loading and sentence-aware chunking."""

import csv
import re
from pathlib import Path

from pypdf import PdfReader

from .config import (
    DEFAULT_CHUNK_OVERLAP_TOKENS,
    DEFAULT_CHUNK_SIZE_TOKENS,
    DEFAULT_MANIFEST_PATH,
)
from .models import Chunk, Document, PageText


def normalize_whitespace(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def load_manifest(manifest_path: Path) -> dict[str, dict[str, str]]:
    with manifest_path.open(encoding="utf-8", newline="") as manifest_file:
        return {row["filename"]: row for row in csv.DictReader(manifest_file)}


def parse_pdf_document(path: Path, manifest: dict[str, dict[str, str]]) -> Document:
    pages: list[PageText] = []
    for page_number, page in enumerate(PdfReader(path).pages, start=1):
        extracted = page.extract_text() or ""
        extracted = re.sub(r"(?<=\w)-\s*\n\s*(?=\w)", "", extracted)
        cleaned = normalize_whitespace(extracted)
        if cleaned:
            pages.append(PageText(page_number=page_number, text=cleaned))

    metadata = manifest[path.name]
    topics = tuple(
        topic.strip()
        for topic in metadata.get("topics", "").split(",")
        if topic.strip()
    )
    return Document(
        document_id=path.stem,
        title=metadata["title"],
        source_url=metadata["source_url"],
        year=metadata["year"],
        topics=topics,
        filename=path.name,
        pages=tuple(pages),
    )


def load_documents(
    document_dir: Path, manifest_path: Path = DEFAULT_MANIFEST_PATH
) -> list[Document]:
    paths = sorted(document_dir.glob("*.pdf"))
    if not paths:
        raise FileNotFoundError(f"No PDF documents found in: {document_dir}")
    manifest = load_manifest(manifest_path)
    return [parse_pdf_document(path, manifest) for path in paths]


def split_sentences(text: str) -> list[str]:
    return [
        sentence.strip()
        for sentence in re.split(
            r"(?<=[.!?])\s+(?=[A-Z0-9])", normalize_whitespace(text)
        )
        if sentence.strip()
    ]


def token_count(text: str, tokenizer, add_special_tokens: bool = True) -> int:
    return len(
        tokenizer.encode(text, add_special_tokens=add_special_tokens, verbose=False)
    )


def split_oversized_text(
    text: str, max_content_tokens: int, overlap: int, tokenizer
) -> list[str]:
    if token_count(text, tokenizer, add_special_tokens=False) <= max_content_tokens:
        return [text]
    offsets = tokenizer(
        text,
        add_special_tokens=False,
        return_offsets_mapping=True,
        truncation=False,
        verbose=False,
    )["offset_mapping"]
    parts = []
    step = max_content_tokens - overlap
    for start in range(0, len(offsets), step):
        group = offsets[start : start + max_content_tokens]
        parts.append(text[group[0][0] : group[-1][1]].strip())
        if start + max_content_tokens >= len(offsets):
            break
    return parts


def chunk_document(
    document: Document,
    tokenizer,
    chunk_size: int = DEFAULT_CHUNK_SIZE_TOKENS,
    overlap: int = DEFAULT_CHUNK_OVERLAP_TOKENS,
) -> list[Chunk]:
    if chunk_size <= 0:
        raise ValueError("chunk_size must be greater than zero")
    if overlap < 0 or overlap >= chunk_size:
        raise ValueError("overlap must be non-negative and smaller than chunk_size")

    max_tokens = chunk_size - tokenizer.num_special_tokens_to_add(pair=False)
    sentence_pages = []
    for page in document.pages:
        for sentence in split_sentences(page.text):
            for part in split_oversized_text(sentence, max_tokens, overlap, tokenizer):
                sentence_pages.append(
                    (
                        part,
                        page.page_number,
                        token_count(part, tokenizer, add_special_tokens=False),
                    )
                )
    if not sentence_pages:
        return []

    records: list[tuple[str, int, int]] = []
    start = 0
    while start < len(sentence_pages):
        end = start
        current_tokens = 0
        while end < len(sentence_pages):
            sentence_tokens = sentence_pages[end][2]
            if end > start and current_tokens + sentence_tokens > max_tokens:
                break
            current_tokens += sentence_tokens
            end += 1

        selected = sentence_pages[start:end]
        records.append(
            (
                " ".join(sentence for sentence, _, _ in selected),
                min(page for _, page, _ in selected),
                max(page for _, page, _ in selected),
            )
        )
        if end >= len(sentence_pages):
            break

        overlap_tokens = 0
        next_start = end
        while next_start > start and overlap_tokens < overlap:
            next_start -= 1
            overlap_tokens += sentence_pages[next_start][2]
        start = max(start + 1, next_start)

    return [
        Chunk(
            chunk_id=f"{document.document_id}::chunk_{index:03d}",
            document_id=document.document_id,
            text=text,
            title=document.title,
            source_url=document.source_url,
            year=document.year,
            topics=document.topics,
            page_start=page_start,
            page_end=page_end,
        )
        for index, (text, page_start, page_end) in enumerate(records, start=1)
    ]


def build_chunks(
    documents: list[Document],
    tokenizer,
    chunk_size: int = DEFAULT_CHUNK_SIZE_TOKENS,
    overlap: int = DEFAULT_CHUNK_OVERLAP_TOKENS,
) -> list[Chunk]:
    return [
        chunk
        for document in documents
        for chunk in chunk_document(document, tokenizer, chunk_size, overlap)
    ]
