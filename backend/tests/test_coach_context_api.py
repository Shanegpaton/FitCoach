"""Real PostgreSQL coverage: RLS, fenced jobs, provenance, and memory controls."""
import json
from uuid import UUID, uuid4

import sqlalchemy as sa

from backend.agent import context_store as contexts
from backend.agent.context import ModelBudget
from backend.conversations import begin_turn, finish_turn


def headers(account='a', etag=None):
    result = {'Authorization': f'Bearer {account}'}
    if etag:
        result['If-Match'] = etag
    return result


async def conversation(api, exchanges=1):
    client, database, users, _ = api
    cid = UUID((await client.post('/v1/coach/conversations', json={}, headers=headers())).json()['id'])
    async with contexts.transaction(database, users['a'], True) as session:
        await contexts.ensure(session, users['a'], cid, memory_floor=0)
    messages = []
    for i in range(exchanges):
        rid = uuid4()
        claim = await begin_turn(database, users['a'], cid, rid, f'I prefer dumbbells. Note {i}.')
        await finish_turn(database, users['a'], cid, rid, 'Understood.', attempt_id=claim['attemptId'])
        messages.append(claim['userMessageId'])
    return cid, messages


async def test_memory_versions_and_account_isolation(api):
    client, database, users, _ = api
    cid, _ = await conversation(api)
    mid = uuid4()
    async with contexts.transaction(database, users['a'], True) as session:
        await session.execute(sa.text("""INSERT INTO fitcoach.coach_memories(user_id,id,memory_key,content,category,source_conversation)
            VALUES (:u,:id,'equipment','Prefers dumbbells','equipment',:c)"""), {'u': users['a'], 'id': mid, 'c': cid})
    listing = await client.get('/v1/coach/memories', headers=headers())
    assert listing.status_code == 200
    item = listing.json()['items'][0]
    assert (await client.get('/v1/coach/memories', headers=headers('b'))).json()['items'] == []
    assert (await client.patch(f'/v1/coach/memories/{mid}', headers=headers('b', item['etag']), json={'content': 'changed'})).status_code == 404
    assert (await client.patch(f'/v1/coach/memories/{mid}', headers=headers(), json={'content': 'changed'})).status_code == 428
    changed = await client.patch(f'/v1/coach/memories/{mid}', headers=headers(etag=item['etag']), json={'content': 'Prefers barbells'})
    assert changed.status_code == 200
    assert (await client.delete(f'/v1/coach/memories/{mid}', headers=headers(etag=item['etag']))).status_code == 412
    current = (await client.get('/v1/coach/memories', headers=headers())).json()['items'][0]
    assert current['edited'] and current['content'] == 'Prefers barbells'
    assert (await client.delete(f'/v1/coach/memories/{mid}', headers=headers(etag=current['etag']))).status_code == 204
    async with contexts.transaction(database, users['a']) as session:
        assert await session.scalar(sa.text('SELECT deleted FROM fitcoach.coach_memories WHERE id=:id'), {'id': mid}) is True
    async with database.sessions() as session, session.begin():
        assert await session.scalar(sa.text('SELECT count(*) FROM fitcoach.coach_memories')) == 0
    assert (await client.get(f'/v1/coach/conversations/{cid}/context', headers=headers('b'))).status_code == 404


async def test_summary_keeps_raw_history_and_job_is_idempotent(api, monkeypatch):
    _, database, users, _ = api
    cid, _ = await conversation(api, 3)
    await contexts.queue_summary(database, users['a'], cid)
    job = await contexts.claim_job(database, users['a'], cid, 'summary')
    assert job and await contexts.claim_job(database, users['a'], cid, 'summary') is None
    async def summarize(*args, **kwargs):
        assert args[2] == []  # Maintenance has no training mutation/proposal tools.
        return {'text': 'User prefers dumbbells. Two older exchanges completed.'}
    monkeypatch.setattr(contexts, 'complete_agent_turn', summarize)
    assert await contexts.process_job(database, users['a'], 'token', ModelBudget('unknown'), job)
    state, _ = await contexts.state(database, users['a'], cid)
    assert state['covered'] == 4
    assert await contexts.claim_job(database, users['a'], cid, 'summary') is None
    async with contexts.transaction(database, users['a']) as session:
        assert await session.scalar(sa.text('SELECT count(*) FROM fitcoach.coach_messages WHERE conversation_id=:c'), {'c': cid}) == 6


async def test_memory_extraction_and_clear_fences_pending_work(api, monkeypatch):
    client, database, users, _ = api
    cid, messages = await conversation(api)
    async def extract(*args, **kwargs):
        assert args[2] == []
        return {'text': json.dumps({'memories': [{'key': 'equipment', 'content': 'Prefers dumbbells', 'category': 'equipment', 'sourceMessageIds': messages, 'corrects': False}]})}
    monkeypatch.setattr(contexts, 'complete_agent_turn', extract)
    job = await contexts.claim_job(database, users['a'], cid, 'memory')
    assert job
    result = await contexts.process_job(database, users['a'], 'token', ModelBudget('unknown'), job)
    assert result['memoryChanged']
    saved = (await client.get('/v1/coach/memories', headers=headers())).json()
    assert saved['items'][0]['sources'][0]['messageId'] == messages[0]
    # Queue a later turn; clear memory while its extraction call is in flight.
    rid = uuid4(); claim = await begin_turn(database, users['a'], cid, rid, 'I prefer barbells now.')
    await finish_turn(database, users['a'], cid, rid, 'Understood.', attempt_id=claim['attemptId'])
    job = await contexts.claim_job(database, users['a'], cid, 'memory')
    async def clear_during_inference(*args, **kwargs):
        assert (await client.delete('/v1/coach/memories', headers=headers(etag=saved['etag']))).status_code == 204
        return {'text': json.dumps({'memories': [{'key': 'equipment', 'content': 'Prefers barbells', 'category': 'equipment', 'sourceMessageIds': [claim['userMessageId']], 'corrects': True}]})}
    monkeypatch.setattr(contexts, 'complete_agent_turn', clear_during_inference)
    assert await contexts.process_job(database, users['a'], 'token', ModelBudget('unknown'), job) is False
    assert (await client.get('/v1/coach/memories', headers=headers())).json()['items'] == []


async def test_expired_job_can_be_reclaimed_and_stale_result_cannot_publish(api, monkeypatch):
    _, database, users, _ = api
    cid, _ = await conversation(api, 3)
    await contexts.queue_summary(database, users['a'], cid)
    first = await contexts.claim_job(database, users['a'], cid, 'summary')
    async def expire_and_reclaim(*args, **kwargs):
        async with contexts.transaction(database, users['a'], True) as session:
            await session.execute(sa.text("UPDATE fitcoach.coach_context_jobs SET lease_until=now()-interval '1 second' WHERE conversation_id=:c AND kind='summary'"), {'c': cid})
        second = await contexts.claim_job(database, users['a'], cid, 'summary')
        assert second['attempt'] != first['attempt']
        return {'text': 'Stale summary'}
    monkeypatch.setattr(contexts, 'complete_agent_turn', expire_and_reclaim)
    assert await contexts.process_job(database, users['a'], 'token', ModelBudget('unknown'), first) is False
    state, _ = await contexts.state(database, users['a'], cid)
    assert state['covered'] == 0 and state['summary'] == ''


async def test_disabling_memory_and_deleting_source_conversation(api, monkeypatch):
    client, database, users, _ = api
    cid, messages = await conversation(api)
    async def extract(*args, **kwargs):
        return {'text': json.dumps({'memories': [{'key': 'equipment', 'content': 'Prefers dumbbells', 'category': 'equipment', 'sourceMessageIds': messages}]})}
    monkeypatch.setattr(contexts, 'complete_agent_turn', extract)
    job = await contexts.claim_job(database, users['a'], cid, 'memory')
    await contexts.process_job(database, users['a'], 'token', ModelBudget('unknown'), job)
    saved = (await client.get('/v1/coach/memories', headers=headers())).json()
    assert (await client.patch('/v1/coach/memory-settings', headers=headers(etag=saved['etag']), json={'automatic': False})).status_code == 200
    assert (await client.get('/v1/coach/memories', headers=headers())).json()['items']  # Disabling retains facts.
    assert (await client.delete(f'/v1/coach/conversations/{cid}', headers=headers())).status_code == 204
    assert (await client.get('/v1/coach/memories', headers=headers())).json()['items'] == []


async def test_foreground_coach_uses_one_model_saved_context_and_idempotent_retry(api, monkeypatch):
    import secrets
    from unittest.mock import AsyncMock
    from backend import app as api_module
    from backend import chatgpt_credentials as vault
    from backend.tests.test_chatgpt_credentials import record
    client, database, users, _ = api
    cid, _ = await conversation(api, 3)
    monkeypatch.setenv('FITCOACH_CHATGPT_SECRET', secrets.token_urlsafe(32))
    credentials = vault.validate_record(record(str(users['a'])), str(users['a']))
    async with contexts.transaction(database, users['a'], True) as session:
        await session.execute(sa.text('INSERT INTO fitcoach.chatgpt_credentials(user_id,ciphertext,plan_usage_granted) VALUES (:u,:b,true)'), {'u': users['a'], 'b': vault.encrypt_record(credentials)})
        await session.execute(sa.text("UPDATE fitcoach.coach_context SET summary='Earlier decision: use two training days.',covered=4 WHERE conversation_id=:c"), {'c': cid})
    budget = ModelBudget('test-model', 128_000)
    resolver = AsyncMock(return_value=budget)
    monkeypatch.setattr(api_module.inference, 'resolve_model', resolver)
    seen = []
    async def reply(token, items, tools, ready, **kwargs):
        assert token == 'access-secret' and kwargs['budget'] == budget
        seen.append(items)
        assert sum(item.get('content') == 'What should I do next?' for item in items) == 1
        assert 'two training days' in items[0]['content']
        return {'output': [{'type': 'message', 'content': [{'type': 'output_text', 'text': 'Continue with your two-day plan.'}]}], 'text': 'Continue with your two-day plan.'}
    monkeypatch.setattr(contexts, 'complete_agent_turn', reply)
    body = {'conversationId': str(cid), 'requestId': str(uuid4()), 'message': {'role': 'user', 'text': 'What should I do next?'}, 'trainingDataReady': False}
    first = await client.post('/v1/chatgpt/coach', headers=headers(), json=body)
    assert first.status_code == 200, first.text
    assert first.json()['context']['summaryAvailable']
    assert first.json()['context']['maintenancePending']
    replay = await client.post('/v1/chatgpt/coach', headers=headers(), json=body)
    assert replay.status_code == 200 and replay.json()['replayed']
    assert resolver.await_count == 1 and len(seen) == 1


async def test_failed_maintenance_releases_lease_and_backs_off_without_writing(api, monkeypatch):
    import pytest
    from backend.agent.inference import InferenceError
    _, database, users, _ = api
    cid, _ = await conversation(api, 3)
    await contexts.queue_summary(database, users['a'], cid)
    job = await contexts.claim_job(database, users['a'], cid, 'summary')
    async def fail(*args, **kwargs):
        raise InferenceError(503, 'Temporary failure')
    monkeypatch.setattr(contexts, 'complete_agent_turn', fail)
    with pytest.raises(InferenceError):
        await contexts.process_job(database, users['a'], 'token', ModelBudget('unknown'), job)
    async with contexts.transaction(database, users['a']) as session:
        row = (await session.execute(sa.text("SELECT failures,attempt,lease_until,retry_at>now() AS delayed FROM fitcoach.coach_context_jobs WHERE conversation_id=:c AND kind='summary'"), {'c': cid})).mappings().one()
        assert row['failures'] == 1 and row['attempt'] is None and row['lease_until'] is None and row['delayed']
    state, _ = await contexts.state(database, users['a'], cid)
    assert state['summary'] == '' and state['covered'] == 0


async def test_switching_to_smaller_window_compacts_before_next_call(api, monkeypatch):
    _, database, users, _ = api
    cid, _ = await conversation(api, 5)
    async with contexts.transaction(database, users['a'], True) as session:
        await session.execute(sa.text("UPDATE fitcoach.coach_messages SET content=CASE role WHEN 'user' THEN repeat('u',4000) ELSE repeat('a',9000) END WHERE conversation_id=:c"), {'c': cid})
    large = contexts.ContextSession(database, users['a'], cid, 'token', ModelBudget('large-unknown', 128_000), [], False)
    original = await large.prepare([])
    assert len(original) == 10
    calls = []
    async def summarize(*args, **kwargs):
        calls.append(kwargs['budget'].window)
        assert args[2] == []
        return {'text': 'Earlier user requests and responses summarized.'}
    monkeypatch.setattr(contexts, 'complete_agent_turn', summarize)
    small_budget = ModelBudget('small-unknown', 32_000)
    small = contexts.ContextSession(database, users['a'], cid, 'token', small_budget, [], False)
    prepared = await small.prepare([])
    assert calls and all(limit == 32_000 for limit in calls)
    assert small_budget.usage(small.instructions, [], prepared) <= small_budget.input_limit
    assert prepared[-1]['content'] == 'a'*9000
    state, _ = await contexts.state(database, users['a'], cid)
    assert state['covered'] > 0 and not state['waiting']
    async with contexts.transaction(database, users['a']) as session:
        assert await session.scalar(sa.text('SELECT count(*) FROM fitcoach.coach_messages WHERE conversation_id=:c'), {'c': cid}) == 10
