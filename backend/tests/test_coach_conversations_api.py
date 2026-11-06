from uuid import UUID, uuid4

import httpx
import pytest
from fastapi import HTTPException

from backend.app import create_app
from backend.config import Settings
from backend.conversations import begin_turn, finish_turn, conversation_messages, fail_turn


def headers(token='a'):
    return {'Authorization': f'Bearer {token}'}


@pytest.mark.asyncio
async def test_conversation_rename_cors_preflight():
    settings = Settings(database_url='postgresql+psycopg://u:p@localhost/db',
                        supabase_url='https://auth.example', supabase_key='test-key',
                        cors_origins=('https://fitcoach.example',), allow_local_plaintext=True)
    app = create_app(settings)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://api') as client:
        response = await client.options('/v1/coach/conversations/example', headers={
            'Origin': 'https://fitcoach.example',
            'Access-Control-Request-Method': 'PATCH',
            'Access-Control-Request-Headers': 'authorization,content-type',
        })
    await app.state.database.close()
    assert response.status_code == 200
    assert response.headers['access-control-allow-origin'] == 'https://fitcoach.example'
    assert 'PATCH' in response.headers['access-control-allow-methods']


@pytest.mark.asyncio
async def test_conversation_crud_is_account_scoped_and_paginated(api):
    client, database, users, _ = api
    preflight = await client.options('/v1/coach/conversations/example', headers={
        'Origin': 'https://fitcoach.example',
        'Access-Control-Request-Method': 'PATCH',
        'Access-Control-Request-Headers': 'authorization,content-type',
    })
    assert preflight.status_code == 200
    assert 'PATCH' in preflight.headers['access-control-allow-methods']
    assert (await client.get('/v1/coach/conversations')).status_code == 401
    created = await client.post('/v1/coach/conversations', headers=headers(), json={})
    assert created.status_code == 201
    conversation_id = created.json()['id']
    assert (await client.get(f'/v1/coach/conversations/{conversation_id}', headers=headers('b'))).status_code == 404
    renamed = await client.patch(f'/v1/coach/conversations/{conversation_id}', headers=headers(), json={'title': 'Bench progression'})
    assert renamed.json()['title'] == 'Bench progression'
    listing = await client.get('/v1/coach/conversations?limit=1', headers=headers())
    assert listing.json()['items'][0]['id'] == conversation_id

    request_id = uuid4()
    cid = UUID(conversation_id)
    claim = await begin_turn(database, users['a'], cid, request_id, 'How is my bench?')
    assert not claim['replay']
    thread_id, context = await conversation_messages(database, users['a'], cid)
    assert thread_id and context == [{'role': 'user', 'text': 'How is my bench?'}]
    with pytest.raises(HTTPException) as concurrent:
        await begin_turn(database, users['a'], cid, uuid4(), 'Another question')
    assert concurrent.value.status_code == 409
    assistant_id = await finish_turn(database, users['a'], cid, request_id,
                                     'You added 2.5 kg last week.', {'artifacts': []}, attempt_id=claim['attemptId'])
    replay = await begin_turn(database, users['a'], cid, request_id, 'How is my bench?')
    assert replay['replay'] and replay['assistantMessageId'] == assistant_id
    _, history = await conversation_messages(database, users['a'], cid)
    assert history == [{'role': 'user', 'text': 'How is my bench?'},
                       {'role': 'assistant', 'text': 'You added 2.5 kg last week.'}]
    retry_id = uuid4()
    retry = await begin_turn(database, users['a'], cid, retry_id, 'What should I do next?')
    await fail_turn(database, users['a'], cid, retry_id, attempt_id=retry['attemptId'])
    retried = await begin_turn(database, users['a'], cid, retry_id, 'What should I do next?')
    assert not retried['replay']
    _, history = await conversation_messages(database, users['a'], cid)
    assert [message['text'] for message in history].count('What should I do next?') == 1
    await fail_turn(database, users['a'], cid, retry_id, attempt_id=retried['attemptId'])

    assert (await client.delete(f'/v1/coach/conversations/{conversation_id}', headers=headers('b'))).status_code == 404
    deleted = await client.delete(f'/v1/coach/conversations/{conversation_id}', headers=headers())
    assert deleted.status_code == 204
    assert (await client.get(f'/v1/coach/conversations/{conversation_id}', headers=headers())).status_code == 404


@pytest.mark.asyncio
async def test_expired_attempt_recovery_fences_reply_proposal_and_cleanup(api):
    import sqlalchemy as sa
    from backend.database import set_identity
    from backend.conversations import read_turn, renew_turn, current_attempt, guard_proposal

    client, database, users, _ = api
    user = users['a']
    cid = UUID((await client.post('/v1/coach/conversations', headers=headers(), json={})).json()['id'])
    rid = uuid4()
    old = await begin_turn(database, user, cid, rid, 'Saved question')
    await renew_turn(database, user, cid, rid, old['attemptId'])
    async with database.sessions() as session:
        async with session.begin():
            await set_identity(session, user)
            await session.execute(sa.text("UPDATE fitcoach.coach_turns SET lease_expires_at=clock_timestamp() - interval '1 second' WHERE conversation_id=:id"), {'id': cid})
    assert (await read_turn(database, user, cid, rid))['status'] == 'failed'
    new = await begin_turn(database, user, cid, rid, 'Saved question')
    assert new['attemptId'] != old['attemptId']
    assert new['threadId'] != old['threadId']
    await fail_turn(database, user, cid, rid, attempt_id=old['attemptId'])
    assert (await read_turn(database, user, cid, rid))['status'] == 'started'
    with pytest.raises(HTTPException):
        await finish_turn(database, user, cid, rid, 'Stale reply', attempt_id=old['attemptId'])
    with pytest.raises(HTTPException):
        await renew_turn(database, user, cid, rid, old['attemptId'])
    token = current_attempt.set((cid, rid, old['attemptId']))
    try:
        import json
        from backend.agent.plan_proposal_service import create_proposal
        from backend.tests.fixtures import plan
        with pytest.raises(HTTPException):
            await create_proposal(database, user, json.dumps({'plan': plan(), 'assumptions': []}))
        async with database.sessions() as session:
            async with session.begin():
                await set_identity(session, user)
                with pytest.raises(HTTPException):
                    await guard_proposal(session, user)
    finally:
        current_attempt.reset(token)
    await finish_turn(database, user, cid, rid, 'Current reply', attempt_id=new['attemptId'])
    _, history = await conversation_messages(database, user, cid)
    assert [m['text'] for m in history] == ['Saved question', 'Current reply']


@pytest.mark.asyncio
async def test_failed_retry_cannot_bypass_active_turn_and_expiry_allows_delete(api):
    import sqlalchemy as sa
    from backend.database import set_identity
    client, database, users, _ = api
    user = users['a']
    cid = UUID((await client.post('/v1/coach/conversations', headers=headers(), json={})).json()['id'])
    first_id, active_id = uuid4(), uuid4()
    first = await begin_turn(database, user, cid, first_id, 'First')
    await fail_turn(database, user, cid, first_id, attempt_id=first['attemptId'])
    await begin_turn(database, user, cid, active_id, 'Second')
    with pytest.raises(HTTPException) as conflict:
        await begin_turn(database, user, cid, first_id, 'First')
    assert conflict.value.status_code == 409
    assert (await client.delete(f'/v1/coach/conversations/{cid}', headers=headers())).status_code == 409
    async with database.sessions() as session:
        async with session.begin():
            await set_identity(session, user)
            await session.execute(sa.text("UPDATE fitcoach.coach_turns SET lease_expires_at=clock_timestamp() - interval '1 second' WHERE conversation_id=:id"), {'id': cid})
    assert (await client.delete(f'/v1/coach/conversations/{cid}', headers=headers())).status_code == 204


@pytest.mark.asyncio
async def test_only_one_competing_claim_can_recover_an_expired_turn(api):
    import asyncio
    import sqlalchemy as sa
    from backend.database import set_identity
    client, database, users, _ = api
    user = users['a']
    cid = UUID((await client.post('/v1/coach/conversations', headers=headers(), json={})).json()['id'])
    rid = uuid4()
    await begin_turn(database, user, cid, rid, 'Retry once')
    async with database.sessions() as session:
        async with session.begin():
            await set_identity(session, user)
            await session.execute(sa.text("UPDATE fitcoach.coach_turns SET lease_expires_at=clock_timestamp() - interval '1 second' WHERE conversation_id=:id"), {'id': cid})
    results = await asyncio.gather(
        begin_turn(database, user, cid, rid, 'Retry once'),
        begin_turn(database, user, cid, rid, 'Retry once'), return_exceptions=True)
    assert sum(isinstance(result, dict) for result in results) == 1
    conflicts = [result for result in results if isinstance(result, HTTPException)]
    assert len(conflicts) == 1 and conflicts[0].status_code == 409
    _, history = await conversation_messages(database, user, cid)
    assert history == [{'role': 'user', 'text': 'Retry once'}]
