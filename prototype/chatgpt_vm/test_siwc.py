import stat
import threading
import sys
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest

from prototype.chatgpt_vm import siwc


def test_authorization_request_and_restart(tmp_path):
    path = tmp_path / 'private' / 'host.json'
    first = siwc.host_id(path)
    assert first.startswith('urn:uuid:')
    assert siwc.host_id(path) == first
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert stat.S_IMODE(path.parent.stat().st_mode) == 0o700
    url = siwc.authorization_url(host=first, redirect_uri='http://127.0.0.1:1234/auth/callback',
                                 state='state', nonce='nonce', verifier='verifier', saved=None)
    query = parse_qs(urlsplit(url).query)
    assert query['client_id'] == ['dynamic_agent_client']
    assert query['agent_name_hint'] == ['FitCoachGPT']
    assert query['code_challenge_method'] == ['S256']
    assert query['redirect_uri'] == ['http://127.0.0.1:1234/auth/callback']
    assert query['resource'] == [siwc.RESOURCE]
    assert set(query['scope'][0].split()) == set(siwc.SCOPES.split())
    returning = parse_qs(urlsplit(siwc.authorization_url(host=first,
        redirect_uri='http://127.0.0.1:1234/auth/callback', state='next', nonce='next',
        verifier='next', saved={'client_id': 'oaiapp_1', 'id_token': 'old', 'email': 'a@example.com'})).query)
    assert returning['client_id'] == ['oaiapp_1']
    assert 'agent_name_hint' not in returning


@pytest.mark.parametrize('query', [
    'code=one&state=wrong&client_id=oaiapp_1',
    'code=one&state=right',
    'code=one&state=right&client_id=dynamic_agent_client',
    'code=one&state=right&client_id=oaiapp_1&client_id=oaiapp_2',
])
def test_invalid_new_callback(query):
    with pytest.raises(siwc.SignInError):
        siwc.callback_result(query, 'right', None)


def test_decline_and_reconnection_identity():
    assert siwc.callback_result('state=right&error=access_denied', 'right', None) is None
    saved = {'client_id': 'oaiapp_1', 'subject': 'original'}
    assert siwc.callback_result('state=right&code=one', 'right', saved) == ('one', 'oaiapp_1')
    with pytest.raises(siwc.SignInError):
        siwc.callback_result('state=right&code=one&client_id=oaiapp_2', 'right', saved)
    tokens = {'access_token': 'access', 'refresh_token': 'refresh', 'id_token': 'id',
              'scope': 'openid profile email offline_access resource.invoke'}
    record = siwc.credential_record(tokens, {'sub': 'original'}, 'oaiapp_1', 'host', saved)
    assert record['plan_usage_granted'] is False
    with pytest.raises(siwc.SignInError):
        siwc.credential_record(tokens, {'sub': 'other'}, 'oaiapp_1', 'host', saved)
    tokens['scope'] += ' chatgpt.tokens.use.direct'
    assert siwc.credential_record(tokens, {'sub': 'original'}, 'oaiapp_1', 'host', saved)['plan_usage_granted']


def test_loopback_callback_is_one_shot():
    try:
        server, done, result = siwc.listen_for_callback()
    except PermissionError:
        pytest.skip('This sandbox does not permit binding a loopback socket')
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        base = f'http://127.0.0.1:{server.server_port}'
        with httpx.Client() as client:
            assert client.get(base + '/auth/callback?state=right&code=first').status_code == 200
            assert done.is_set()
            assert client.get(base + '/auth/callback?state=right&code=second').status_code == 404
        assert result['query'] == 'state=right&code=first'
    finally:
        server.shutdown()
        server.server_close()


def test_protected_credential_file(tmp_path):
    path = tmp_path / 'private' / 'credentials.json'
    siwc.private_write(path, {'refresh_token': 'secret'})
    assert siwc.private_read(path) == {'refresh_token': 'secret'}
    path.chmod(0o644)
    with pytest.raises(siwc.SignInError):
        siwc.private_read(path)


def test_vm_browser_uses_private_dedicated_profile(tmp_path, monkeypatch):
    profile = tmp_path / 'firefox-profile'
    monkeypatch.setenv('FITCOACH_VM_FIREFOX_PROFILE', str(profile))
    launched = {}

    def fake_popen(args, **kwargs):
        launched['args'] = args
        launched['kwargs'] = kwargs
        return SimpleNamespace(wait=lambda timeout: 0)

    monkeypatch.setattr(siwc.subprocess, 'Popen', fake_popen)
    siwc.open_vm_browser('https://example.com/sign-in')
    assert launched['args'] == ['/usr/bin/firefox', '--profile', str(profile),
                                '--new-window', 'https://example.com/sign-in']
    assert stat.S_IMODE(profile.stat().st_mode) == 0o700
    assert launched['kwargs']['stdout'] == siwc.subprocess.DEVNULL


def test_identity_verification_requires_claims_and_nonce(monkeypatch):
    calls = {}
    class KeyClient:
        def __init__(self, url):
            assert url == siwc.JWKS
        def get_signing_key_from_jwt(self, token):
            assert token == 'id-token'
            return SimpleNamespace(key='public-key')
    def decode(token, key, **options):
        calls.update(options)
        return {'sub': 'subject', 'nonce': 'expected'}
    monkeypatch.setitem(sys.modules, 'jwt', SimpleNamespace(PyJWKClient=KeyClient, decode=decode))
    assert siwc.verify_identity('id-token', 'oaiapp_1', 'expected')['sub'] == 'subject'
    assert calls['algorithms'] == ['RS256']
    assert calls['issuer'] == siwc.ISSUER
    assert calls['audience'] == 'oaiapp_1'
    assert {'iss', 'aud', 'exp', 'iat', 'sub', 'nonce'} <= set(calls['options']['require'])
    with pytest.raises(siwc.SignInError):
        siwc.verify_identity('id-token', 'oaiapp_1', 'wrong')
