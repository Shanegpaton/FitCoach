import json
import secrets

import httpx
import pytest
import sqlalchemy as sa

from backend import chatgpt_credentials as vault
from backend.agent import inference
from backend.agent.context_store import transaction
from backend.tests.fixtures import headers
from backend.tests.test_chatgpt_credentials import record


def catalog(monkeypatch, models):
    requests = []
    def respond(request):
        requests.append(request)
        assert request.url.path == '/v1/models', 'Unavailable choices must never invoke inference'
        return httpx.Response(200, json={'models': models})
    real = httpx.AsyncClient
    monkeypatch.setattr(inference.httpx, 'AsyncClient', lambda **kwargs: real(transport=httpx.MockTransport(respond)))
    return requests


def item(name):
    return {'slug': name, 'visibility': 'list', 'context_window': 32000}


async def test_explicit_model_is_independent_of_catalog_order(monkeypatch):
    monkeypatch.setenv('FITCOACH_COACH_MODEL', 'preferred')
    entries = [item('other'), item('preferred')]
    catalog(monkeypatch, entries)
    assert (await inference.resolve_model('token')).model == 'preferred'
    entries.reverse()
    assert (await inference.resolve_model('token')).model == 'preferred'
    assert (await inference.resolve_model('token', 'other')).model == 'other'


async def test_unconfigured_or_unavailable_model_never_falls_back(monkeypatch):
    monkeypatch.delenv('FITCOACH_COACH_MODEL', raising=False)
    requests = catalog(monkeypatch, [item('fallback')])
    with pytest.raises(inference.InferenceError, match='Choose a model on the Coach page'):
        await inference.resolve_model('token')
    assert not requests
    with pytest.raises(inference.InferenceError, match='unavailable'):
        await inference.resolve_model('token', 'missing')
    assert len(requests) == 1


async def test_hidden_models_cannot_be_selected(monkeypatch):
    catalog(monkeypatch, [{**item('hidden'), 'visibility': 'hidden'}, item('visible')])
    assert [m['slug'] for m in await inference.available_models('token')] == ['visible']
    with pytest.raises(inference.InferenceError, match='unavailable'):
        await inference.resolve_model('token', 'hidden')


async def test_catalog_failure_never_invokes_another_model(monkeypatch):
    def respond(request):
        assert request.url.path == '/v1/models'
        return httpx.Response(503)
    real = httpx.AsyncClient
    monkeypatch.setattr(inference.httpx, 'AsyncClient', lambda **kwargs: real(transport=httpx.MockTransport(respond)))
    with pytest.raises(inference.InferenceError, match='discovery is unavailable'):
        await inference.resolve_model('token', 'preferred')


async def test_model_preferences_are_owned_versioned_and_preserved_when_unavailable(api, monkeypatch):
    client, database, users, _ = api
    monkeypatch.delenv('FITCOACH_COACH_MODEL', raising=False)
    monkeypatch.setenv('FITCOACH_CHATGPT_SECRET', secrets.token_urlsafe(32))
    for user in users.values():
        credentials = vault.validate_record(record(str(user)), str(user))
        async with transaction(database, user, True) as session:
            await session.execute(sa.text('INSERT INTO fitcoach.chatgpt_credentials(user_id,ciphertext,plan_usage_granted) VALUES (:u,:b,true)'), {'u': user, 'b': vault.encrypt_record(credentials)})
    models = [item('preferred'), item('fallback')]
    catalog(monkeypatch, models)
    first = await client.get('/v1/chatgpt/models', headers=headers())
    assert first.status_code == 200 and first.json()['selectedModel'] is None
    assert 'access-secret' not in json.dumps(first.json())
    body = {'preferredModel': 'preferred'}
    assert (await client.put('/v1/chatgpt/models', headers=headers(), json=body)).status_code == 428
    assert (await client.put('/v1/chatgpt/models', headers=headers(etag=first.json()['etag']), json=body)).status_code == 200
    assert (await client.put('/v1/chatgpt/models', headers=headers(etag=first.json()['etag']), json={'preferredModel': 'fallback'})).status_code == 412
    current = (await client.get('/v1/chatgpt/models', headers=headers())).json()
    assert current['preferredModel'] == current['selectedModel'] == 'preferred'
    assert (await client.get('/v1/chatgpt/models', headers=headers('b'))).json()['preferredModel'] is None
    models.pop(0)
    unavailable = (await client.get('/v1/chatgpt/models', headers=headers())).json()
    assert unavailable['preferredModel'] == 'preferred' and unavailable['selectedModel'] is None
    assert (await client.put('/v1/chatgpt/models', headers=headers(etag=current['etag']), json=body)).status_code == 409
    assert (await client.put('/v1/chatgpt/models', headers=headers(etag=current['etag']), json={'preferredModel': 'fallback'})).status_code == 200
    assert (await client.get('/v1/chatgpt/models', headers=headers())).json()['selectedModel'] == 'fallback'
    monkeypatch.setenv('FITCOACH_COACH_MODEL', 'fallback')
    current = (await client.get('/v1/chatgpt/models', headers=headers())).json()
    assert (await client.put('/v1/chatgpt/models', headers=headers(etag=current['etag']), json={'preferredModel': None})).status_code == 200
    default = (await client.get('/v1/chatgpt/models', headers=headers())).json()
    assert default['preferredModel'] is None and default['selectedModel'] == 'fallback'
    assert (await client.put('/v1/chatgpt/models', headers=headers(etag=default['etag']), json={'preferredModel': 'preferred', 'userId': str(users['b'])})).status_code == 422
    async with transaction(database, users['b'], True) as session:
        result = await session.execute(sa.text("UPDATE fitcoach.coach_model_settings SET preferred_model='other' WHERE user_id=:u"), {'u': users['a']})
        assert result.rowcount == 0
    async with database.sessions() as session, session.begin():
        assert await session.scalar(sa.text('SELECT count(*) FROM fitcoach.coach_model_settings')) == 0
