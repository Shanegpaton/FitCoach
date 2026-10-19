import threading
from uuid import uuid4

from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect
import pytest

from prototype.chatgpt_vm import gateway, siwc


class FakeProcess:
    def __init__(self):
        self.done = threading.Event()
        self.code = 0
        self.terminated = False

    def wait(self, timeout=None):
        if not self.done.wait(timeout):
            raise gateway.subprocess.TimeoutExpired('fake', timeout)
        return self.code

    def terminate(self):
        self.terminated = True
        self.done.set()

    def kill(self):
        self.terminate()


@pytest.fixture
def setup(tmp_path):
    owner = str(uuid4())
    other = str(uuid4())
    process = FakeProcess()

    async def verify(token):
        if token == 'owner': return owner
        if token == 'other': return other
        raise ValueError('bad token')

    vm = gateway.Gateway(tmp_path / 'private', 'https://auth.example', 'anon',
                         'https://vm.example', 'https://app.example,https://old-app.example',
                         verify_user=verify, launch_process=lambda _: process,
                         reset_browser=lambda: None)
    client = TestClient(gateway.create_app(vm), follow_redirects=False)
    return vm, client, process, owner, other


def auth(token='owner'):
    return {'Authorization': f'Bearer {token}'}


def test_cors_accepts_configured_app_origins_only(setup):
    _, client, _, _, _ = setup
    for origin in ('https://app.example', 'https://old-app.example'):
        response = client.options('/v1/connection', headers={
            'Origin': origin, 'Access-Control-Request-Method': 'GET',
            'Access-Control-Request-Headers': 'authorization',
        })
        assert response.status_code == 200
        assert response.headers['access-control-allow-origin'] == origin
    response = client.options('/v1/connection', headers={
        'Origin': 'https://other.example', 'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization',
    })
    assert response.status_code == 400


def test_exclusive_lease(setup):
    vm, client, process, owner, _ = setup
    assert client.get('/v1/connection', headers=auth()).json()['paired'] is False
    assert client.post('/v1/pair', headers=auth(), json={'code': 'x' * 24}).status_code == 404
    attempt = client.post('/v1/attempts', headers=auth()).json()
    assert siwc.private_read(vm.storage / 'owner.json')['user_id'] == owner
    assert client.get('/v1/connection', headers=auth('other')).json()['busy'] is True
    assert client.post('/v1/attempts', headers=auth('other')).status_code == 409

    assert attempt['state'] == 'pending'
    resumed = client.post('/v1/attempts', headers=auth()).json()
    assert resumed['id'] == attempt['id']
    assert resumed['viewerToken'] != attempt['viewerToken']
    assert 'launchUrl' not in attempt
    assert client.get('/v1/browser-auth').status_code == 404
    process.done.set()
    process.wait(1)


def test_finished_attempt_closes_viewer(setup):
    vm, client, process, _, _ = setup
    attempt = client.post('/v1/attempts', headers=auth()).json()
    process.done.set()
    for _ in range(100):
        status = client.get(f"/v1/attempts/{attempt['id']}", headers=auth()).json()
        if status['state'] != 'pending': break
        threading.Event().wait(0.01)
    assert status['state'] == 'declined'
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect('/v1/viewer', headers={'origin': 'https://app.example'},
                                      subprotocols=[f"fitcoach.{attempt['viewerToken']}"]):
            pass


def test_embedded_viewer_requires_attempt_token_and_app_origin(setup, monkeypatch):
    vm, client, process, _, _ = setup
    attempt = client.post('/v1/attempts', headers=auth()).json()
    protocol = f"fitcoach.{attempt['viewerToken']}"

    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect('/v1/viewer', headers={'origin': 'https://other.example'},
                                      subprotocols=[protocol]):
            pass
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect('/v1/viewer', headers={'origin': 'https://app.example'},
                                      subprotocols=['fitcoach.invalid']):
            pass

    class Reader:
        async def read(self, _):
            return b'RFB 003.008\n'

    class Writer:
        def close(self): pass
        async def wait_closed(self): pass

    async def fake_open(*_):
        return Reader(), Writer()

    monkeypatch.setattr(gateway.asyncio, 'open_connection', fake_open)
    with client.websocket_connect('/v1/viewer', headers={'origin': 'https://app.example'},
                                  subprotocols=[protocol]) as ws:
        assert ws.receive_bytes() == b'RFB 003.008\n'
    process.done.set()


def test_attempt_success_and_disconnect_cancel(setup, monkeypatch):
    vm, client, process, _, _ = setup
    attempt = client.post('/v1/attempts', headers=auth()).json()
    siwc.private_write(vm.storage / 'credentials.json', {'email': 'verified@example.com',
        'name': 'Verified', 'plan_usage_granted': True})
    process.done.set()
    for _ in range(100):
        result = client.get(f"/v1/attempts/{attempt['id']}", headers=auth()).json()
        if result['state'] != 'pending': break
        threading.Event().wait(0.01)
    assert result['state'] == 'connected'
    assert result['connection']['email'] == 'verified@example.com'
    assert result['connection']['planUsageGranted'] is True
    assert client.delete('/v1/connection', headers=auth()).status_code == 204
    assert client.get('/v1/connection', headers=auth()).json()['connected'] is False


def test_lease_expiry_and_pending_cancellation(setup, monkeypatch):
    vm, client, process, _, _ = setup
    attempt = client.post('/v1/attempts', headers=auth()).json()
    stored = siwc.private_read(vm.storage / 'owner.json')
    siwc.private_write(vm.storage / 'owner.json', {**stored, 'expires_at': 0})
    assert client.get('/v1/connection', headers=auth('other')).json()['busy'] is False
    assert process.terminated
    assert client.post('/v1/attempts', headers=auth('other')).status_code == 200
    # The original owner can no longer access the new lease.
    assert client.get(f"/v1/attempts/{attempt['id']}", headers=auth()).status_code == 403
    vm.stop()


def test_handoff_requires_owner_service_key_and_is_single_use(setup, monkeypatch):
    vm, client, _, owner, _ = setup
    client.post('/v1/attempts', headers=auth())
    siwc.private_write(vm.storage / 'credentials.json', {'access_token': 'access',
        'refresh_token': 'refresh', 'id_token': 'id', 'client_id': 'oaiapp_test'})
    monkeypatch.setenv('FITCOACH_VM_HANDOFF_KEY', 'secret-' * 8)
    issued = client.post('/v1/handoff', headers=auth()).json()['code']
    assert 'access' not in issued
    assert client.post('/v1/handoff', headers=auth('other')).status_code == 403
    assert client.post('/v1/handoff/redeem', headers=auth(), json={'code': issued}).status_code == 403
    headers = {**auth(), 'X-FitCoach-Handoff-Key': 'secret-' * 8}
    redeemed = client.post('/v1/handoff/redeem', headers=headers, json={'code': issued})
    assert redeemed.status_code == 200
    assert redeemed.json()['userId'] == owner
    assert redeemed.json()['credentials']['refresh_token'] == 'refresh'
    assert client.post('/v1/handoff/redeem', headers=headers, json={'code': issued}).status_code == 404
    another = client.post('/v1/handoff', headers=auth()).json()['code']
    assert client.post('/v1/handoff/redeem', headers={**auth('other'), 'X-FitCoach-Handoff-Key': 'secret-' * 8},
                       json={'code': another}).status_code == 403
    vm.handoffs[gateway.hashlib.sha256(another.encode()).hexdigest()] = (owner, 0)
    assert client.post('/v1/handoff/redeem', headers=headers, json={'code': another}).status_code == 404


def test_confirm_clears_vm_before_next_account(setup, monkeypatch):
    vm, client, _, _, _ = setup
    monkeypatch.setenv('FITCOACH_VM_HANDOFF_KEY', 'secret-' * 8)
    assert client.post('/v1/attempts', headers=auth()).status_code == 200
    siwc.private_write(vm.storage / 'credentials.json', {'refresh_token': 'secret'})
    headers = {**auth(), 'X-FitCoach-Handoff-Key': 'secret-' * 8}
    assert client.post('/v1/handoff/confirm', headers=auth()).status_code == 403
    assert (vm.storage / 'credentials.json').exists()
    assert client.post('/v1/handoff/confirm', headers=headers).status_code == 204
    assert not (vm.storage / 'credentials.json').exists()
    assert not (vm.storage / 'owner.json').exists()
    assert client.post('/v1/attempts', headers=auth('other')).status_code == 200


def test_cleanup_failure_keeps_account_lease_and_credentials(setup, monkeypatch):
    vm, client, _, _, _ = setup
    monkeypatch.setenv('FITCOACH_VM_HANDOFF_KEY', 'secret-' * 8)
    assert client.post('/v1/attempts', headers=auth()).status_code == 200
    siwc.private_write(vm.storage / 'credentials.json', {'refresh_token': 'secret'})
    def fail_reset():
        raise OSError('launcher unavailable')
    vm.reset_browser = fail_reset
    response = client.post('/v1/handoff/confirm', headers={
        **auth(), 'X-FitCoach-Handoff-Key': 'secret-' * 8})
    assert response.status_code == 503
    assert (vm.storage / 'credentials.json').exists()
    assert client.post('/v1/attempts', headers=auth('other')).status_code == 409
