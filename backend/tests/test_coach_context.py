"""Context budget and recovery tests; no live model calls."""
from datetime import datetime, timezone
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest

from backend.agent import context as sizing
from backend.agent import context_store as store
from backend.agent.context import ModelBudget, model_budget, count_tokens, exchange_groups, bounded_memories
from backend.agent.inference import ContextLengthError


@pytest.fixture(autouse=True)
def clear_model_cache():
    sizing._limits.clear()
    yield
    sizing._limits.clear()


def test_metadata_registry_and_fallback_are_exact_and_ordered():
    assert model_budget({'slug': 'gpt-5', 'context_window': 100_000}).window == 100_000
    assert model_budget({'slug': 'gpt-5', 'context_window': 100_000}).source == 'metadata'
    sizing._limits.clear()
    assert model_budget({'slug': 'gpt-5'}).window == 400_000
    assert model_budget({'slug': 'gpt-5'}).source == 'registry'
    assert model_budget({'slug': 'gpt-5-custom'}).window == 32_000
    assert model_budget({'slug': 'gpt-5-custom'}).source == 'fallback'


@pytest.mark.parametrize('value', [None, True, -1, 0, '128000', {}, 10**12])
def test_invalid_metadata_uses_fallback(value):
    assert model_budget({'slug': 'test-model', 'context_window': value}).window == 32_000


def test_limit_refresh_reductions_and_cache_expiry(monkeypatch):
    first = model_budget({'slug': 'custom', 'context_window': 128_000})
    assert model_budget({'slug': 'custom'}) == first
    assert model_budget({'slug': 'custom', 'context_length': 16_000}).window == 16_000
    monkeypatch.setattr(sizing.time, 'monotonic', lambda: 10**12)
    assert model_budget({'slug': 'custom'}).window == 32_000


def test_reservations_respect_small_models():
    budget = ModelBudget('small', 8_000, 1000)
    assert budget.output == 1000
    assert budget.input_limit == 6500
    assert ModelBudget('fallback').input_limit == 22_000


def test_unknown_tokenizer_counts_utf8_and_payload_overhead():
    assert count_tokens('💪', 'unknown-model') == 4
    assert count_tokens({'input': 'abc'}, 'unknown-model') > 3


def test_exchange_boundaries_and_memory_priority():
    rows = [{'role': r} for r in ('user', 'assistant', 'user', 'assistant', 'user')]
    assert [len(g) for g in exchange_groups(rows)] == [2, 2, 1]
    now = datetime.now(timezone.utc)
    memories = [dict(id=str(i), content='x'*900, category='health' if i == 3 else 'preference', edited=False, updated_at=now) for i in range(4)]
    selected = bounded_memories(memories, 'unknown')
    assert selected[0]['id'] == '3'
    assert count_tokens(selected, 'unknown') <= 2000


@pytest.mark.parametrize('fraction,queued', [(.699, False), (.7, True), (.701, True)])
async def test_compaction_threshold_is_tokens_not_message_count(monkeypatch, fraction, queued):
    budget = ModelBudget('unknown', 32_000)
    session = store.ContextSession(None, uuid4(), uuid4(), 'token', budget, [], True)
    monkeypatch.setattr(store, 'state', AsyncMock(return_value=({'summary': '', 'covered': 0, 'waiting': False}, [])))
    # Many tiny messages never independently cause compaction.
    monkeypatch.setattr(store, 'recent_rows', AsyncMock(return_value=([{'sequence': i+1, 'role': 'user', 'content': 'x'} for i in range(100)], False)))
    monkeypatch.setattr(ModelBudget, 'usage', lambda *args: budget.input_limit*fraction)
    queue = AsyncMock(); monkeypatch.setattr(store, 'queue_summary', queue)
    items = await session.prepare([])
    assert len(items) == 100
    assert bool(queue.await_count) is queued


async def test_summary_is_reused_without_duplicating_covered_messages(monkeypatch):
    session = store.ContextSession(None, uuid4(), uuid4(), 'token', ModelBudget('unknown', 128_000), [], True)
    monkeypatch.setattr(store, 'state', AsyncMock(return_value=({'summary': 'Earlier decision: two days.', 'covered': 10, 'waiting': False}, [])))
    history = AsyncMock(return_value=([{'role': 'user', 'content': 'What next?'}], False))
    monkeypatch.setattr(store, 'recent_rows', history)
    items = await session.prepare([])
    assert history.call_args.args[3] == 10
    assert len(items) == 2 and 'two days' in items[0]['content']
    assert items[-1]['content'] == 'What next?'


def trace_call(number, proposal=False):
    return [
        {'type': 'function_call', 'call_id': str(number), 'name': 'read', 'arguments': '{}'},
        {'type': 'function_call_output', 'call_id': str(number), 'output': '{"proposal":{"id":"p"}}' if proposal else '{"fact":"training"}'},
    ]


async def test_tool_compaction_preserves_latest_pair_and_proposal(monkeypatch):
    session = store.ContextSession(None, uuid4(), uuid4(), 'token', ModelBudget('unknown'), [], True)
    model = AsyncMock(return_value={'text': 'Earlier lookup: strength goal.'})
    monkeypatch.setattr(store, 'complete_agent_turn', model)
    trace = trace_call(1)+trace_call(2, True)+trace_call(3)
    assert await session.compact_trace(trace)
    assert session.trace_covered == 2
    assert trace[session.trace_covered:] == trace_call(2, True)+trace_call(3)
    assert 'strength' in session.trace_summary
    assert await session.compact_trace(trace[session.trace_covered:]) is False


async def test_context_limit_retry_never_reruns_tools(monkeypatch):
    session = store.ContextSession(None, uuid4(), uuid4(), 'token', ModelBudget('unknown'), [], True)
    prepare = AsyncMock(return_value=[{'role': 'user', 'content': 'question'}])
    monkeypatch.setattr(session, 'prepare', prepare)
    model = AsyncMock(side_effect=[ContextLengthError(), {'text': 'answer'}])
    monkeypatch.setattr(store, 'complete_agent_turn', model)
    assert (await session.respond([], True))['text'] == 'answer'
    assert [call.kwargs['force'] for call in prepare.call_args_list] == [False, True]
    assert model.await_count == 2


async def test_model_detail_discovery_and_daily_cache(monkeypatch):
    import httpx
    from backend.agent import inference
    detail_calls = []
    def respond(request):
        if request.url.path == '/v1/models':
            return httpx.Response(200, json={'models': [{'slug': 'discovered', 'visibility': 'list'}]})
        detail_calls.append(request.url.path)
        return httpx.Response(200, json={'id': 'discovered', 'context_window': 128_000, 'max_output_tokens': 4000})
    real = httpx.AsyncClient
    monkeypatch.setattr(inference.httpx, 'AsyncClient', lambda **kw: real(transport=httpx.MockTransport(respond)))
    first = await inference.resolve_model('token', 'discovered')
    second = await inference.resolve_model('token', 'discovered')
    assert first == second and first.window == 128_000 and first.output == 4000
    assert detail_calls == ['/v1/models/discovered']


def test_provider_small_output_limit_is_respected():
    budget = model_budget({'slug': 'small-output', 'context_window': 32_000, 'max_output_tokens': 500})
    assert budget.output == 500
