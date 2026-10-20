import secrets

import httpx
import pytest
import sqlalchemy as sa
from cryptography.fernet import InvalidToken

from backend import app as api_module
from backend import chatgpt_credentials as vault
from backend.agent import inference
from backend.database import set_identity
from backend.tests.fixtures import headers


def record(user_id: str):
    return {'userId': user_id, 'credentials': {
        'access_token': 'access-secret', 'refresh_token': 'refresh-secret',
        'id_token': 'id-secret', 'client_id': 'oaiapp_test', 'subject': 'openai-subject',
        'ext_agent_host_id': 'urn:uuid:test', 'issuer': 'https://auth.openai.com',
        'email': 'verified@example.com', 'name': 'Verified',
        'scopes': ['openid', 'profile', 'email', 'offline_access', 'resource.invoke',
                   'chatgpt.tokens.use.direct'], 'plan_usage_granted': True, 'expires_at': 9999999999,
    }}


def test_encrypt_record_and_validate_identity(monkeypatch):
    monkeypatch.setenv('FITCOACH_CHATGPT_SECRET', secrets.token_urlsafe(32))
    original = vault.validate_record(record('user-one'), 'user-one')
    ciphertext = vault.encrypt_record(original)
    assert b'access-secret' not in ciphertext
    assert vault.decrypt_record(ciphertext) == original
    monkeypatch.setenv('FITCOACH_CHATGPT_SECRET', secrets.token_urlsafe(32))
    with pytest.raises(InvalidToken):
        vault.decrypt_record(ciphertext)
    with pytest.raises(ValueError):
        vault.validate_record(record('user-one'), 'user-two')
    bad = record('user-one')
    bad['credentials']['plan_usage_granted'] = False
    with pytest.raises(ValueError):
        vault.validate_record(bad, 'user-one')


async def test_handoff_stores_only_for_verified_account(api, monkeypatch):
    client, database, users, _ = api
    secret = secrets.token_urlsafe(32)
    monkeypatch.setenv('FITCOACH_CHATGPT_SECRET', secret)
    monkeypatch.setenv('FITCOACH_CHATGPT_VM_ORIGIN', 'https://vm.example')
    real_client = httpx.AsyncClient

    def vm_response(request):
        assert str(request.url) in ('https://vm.example/v1/handoff/redeem',
                                    'https://vm.example/v1/handoff/confirm')
        assert request.headers['X-FitCoach-Handoff-Key'] == secret
        assert request.headers['Authorization'] == 'Bearer a'
        if str(request.url).endswith('/confirm'):
            return httpx.Response(204)
        return httpx.Response(200, json=record(str(users['a'])))

    monkeypatch.setattr(api_module.httpx, 'AsyncClient',
        lambda **kwargs: real_client(transport=httpx.MockTransport(vm_response)))
    assert (await client.get('/v1/chatgpt/connection', headers=headers())).json()['connected'] is False
    result = await client.post('/v1/chatgpt/handoff', headers=headers(), json={'code': 'x' * 64})
    assert result.status_code == 200, result.text
    assert result.json()['email'] == 'verified@example.com'
    assert result.json()['storedInBackend'] is True
    assert 'access_token' not in result.text
    assert (await client.get('/v1/chatgpt/connection', headers=headers('b'))).json()['connected'] is False
    async with database.sessions() as session:
        async with session.begin():
            await set_identity(session, users['a'])
            ciphertext = await session.scalar(sa.text('''SELECT ciphertext FROM fitcoach.chatgpt_credentials
                WHERE user_id = :user_id'''), {'user_id': users['a']})
    assert b'access-secret' not in ciphertext
    assert vault.decrypt_record(ciphertext)['refresh_token'] == 'refresh-secret'
    async def revoked(_): return True
    monkeypatch.setattr(vault, 'revoke_record', revoked)
    removed = await client.delete('/v1/chatgpt/connection', headers=headers())
    assert removed.status_code == 200
    assert removed.json()['revocationConfirmed'] is True
    assert (await client.get('/v1/chatgpt/connection', headers=headers())).json()['connected'] is False


async def test_coach_uses_only_verified_accounts_credential(api, monkeypatch):
    client, database, users, _ = api
    monkeypatch.setenv('FITCOACH_CHATGPT_SECRET', secrets.token_urlsafe(32))
    owner_record = record(str(users['a']))['credentials']
    async with database.sessions() as session:
        async with session.begin():
            await set_identity(session, users['a'])
            await session.execute(sa.text('''INSERT INTO fitcoach.chatgpt_credentials
                (user_id, ciphertext, email, plan_usage_granted)
                VALUES (:user_id, :ciphertext, :email, true)'''),
                {'user_id': users['a'], 'ciphertext': vault.encrypt_record(owner_record),
                 'email': owner_record['email']})
    seen = []
    async def complete(token, input_items, tools, ready):
        seen.append((token, input_items, tools, ready))
        return {'output': [{'type': 'message', 'content': [
            {'type': 'output_text', 'text': 'Two easy training days are a good start.'}]}],
            'text': 'Two easy training days are a good start.'}
    monkeypatch.setattr(inference, 'complete_agent_turn', complete)
    body = {'messages': [{'role': 'user', 'text': 'Where should I begin?'}],
            'localDate': '2026-10-20', 'trainingDataReady': False}
    other = await client.post('/v1/chatgpt/coach', headers=headers('b'), json=body)
    assert other.status_code == 409
    own = await client.post('/v1/chatgpt/coach', headers=headers(), json=body)
    assert own.status_code == 200
    assert own.json() == {'text': 'Two easy training days are a good start.'}
    assert seen == [('access-secret', [{'role': 'user', 'content': 'Where should I begin?'}], [], False)]
    assert 'access-secret' not in own.text
