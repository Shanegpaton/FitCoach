from uuid import UUID, uuid4

import pytest
from fastapi import HTTPException

from backend.conversations import begin_turn, finish_turn, conversation_messages, fail_turn


def headers(token='a'):
    return {'Authorization': f'Bearer {token}'}


@pytest.mark.asyncio
async def test_conversation_crud_is_account_scoped_and_paginated(api):
    client, database, users, _ = api
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
                                     'You added 2.5 kg last week.', {'artifacts': []})
    replay = await begin_turn(database, users['a'], cid, request_id, 'How is my bench?')
    assert replay['replay'] and replay['assistantMessageId'] == assistant_id
    _, history = await conversation_messages(database, users['a'], cid)
    assert history == [{'role': 'user', 'text': 'How is my bench?'},
                       {'role': 'assistant', 'text': 'You added 2.5 kg last week.'}]
    retry_id = uuid4()
    await begin_turn(database, users['a'], cid, retry_id, 'What should I do next?')
    await fail_turn(database, users['a'], cid, retry_id)
    retried = await begin_turn(database, users['a'], cid, retry_id, 'What should I do next?')
    assert not retried['replay']
    _, history = await conversation_messages(database, users['a'], cid)
    assert [message['text'] for message in history].count('What should I do next?') == 1

    assert (await client.delete(f'/v1/coach/conversations/{conversation_id}', headers=headers('b'))).status_code == 404
    deleted = await client.delete(f'/v1/coach/conversations/{conversation_id}', headers=headers())
    assert deleted.status_code == 204
    assert (await client.get(f'/v1/coach/conversations/{conversation_id}', headers=headers())).status_code == 404
