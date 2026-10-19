import threading
from uuid import uuid4

from fastapi.testclient import TestClient
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
                         'https://vm.example', 'https://app.example',
                         verify_user=verify, launch_process=lambda _: process)
    client = TestClient(gateway.create_app(vm), follow_redirects=False)
    return vm, client, process, owner, other


def auth(token='owner'):
    return {'Authorization': f'Bearer {token}'}


def test_pairing_owner_isolation_and_launch_replay(setup):
    vm, client, process, owner, _ = setup
    code = gateway.create_pair_code(vm.storage)
    assert client.get('/v1/connection', headers=auth()).json()['paired'] is False
    assert client.post('/v1/pair', headers=auth(), json={'code': 'x' * 24}).status_code == 403
    assert client.post('/v1/pair', headers=auth(), json={'code': code}).json()['paired'] is True
    assert siwc.private_read(vm.storage / 'owner.json')['user_id'] == owner
    assert client.get('/v1/connection', headers=auth('other')).status_code == 403
    assert client.post('/v1/attempts', headers=auth('other')).status_code == 403

    attempt = client.post('/v1/attempts', headers=auth()).json()
    assert attempt['state'] == 'pending'
    assert client.post('/v1/attempts', headers=auth()).status_code == 409
    path = attempt['launchUrl'].removeprefix('https://vm.example')
    launched = client.get(path)
    assert launched.status_code == 303
    assert launched.headers['location'].startswith('/browser/vnc.html')
    assert 'httponly' in launched.headers['set-cookie'].lower()
    assert client.get(path).status_code == 404
    assert client.get('/v1/browser-auth').status_code == 401
    browser_cookie = launched.cookies.get('fitcoach_vm_browser')
    assert client.get('/v1/browser-auth', cookies={'fitcoach_vm_browser': browser_cookie}).status_code == 204
    process.done.set()
    process.wait(1)


def test_finished_attempt_cannot_open_browser(setup):
    vm, client, process, _, _ = setup
    code = gateway.create_pair_code(vm.storage)
    client.post('/v1/pair', headers=auth(), json={'code': code})
    attempt = client.post('/v1/attempts', headers=auth()).json()
    process.done.set()
    for _ in range(100):
        status = client.get(f"/v1/attempts/{attempt['id']}", headers=auth()).json()
        if status['state'] != 'pending': break
        threading.Event().wait(0.01)
    assert status['state'] == 'declined'
    assert client.get(attempt['launchUrl'].removeprefix('https://vm.example')).status_code == 404


def test_attempt_success_and_disconnect_cancel(setup, monkeypatch):
    vm, client, process, _, _ = setup
    code = gateway.create_pair_code(vm.storage)
    client.post('/v1/pair', headers=auth(), json={'code': code})
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
    monkeypatch.setattr(siwc, 'disconnect', lambda storage: (storage / 'credentials.json').unlink(missing_ok=True))
    assert client.delete('/v1/connection', headers=auth()).status_code == 204
    assert client.get('/v1/connection', headers=auth()).json()['connected'] is False


def test_pair_code_expiry_and_pending_cancellation(setup, monkeypatch):
    vm, client, process, _, _ = setup
    code = gateway.create_pair_code(vm.storage)
    pair_file = vm.storage / 'pairing.json'
    stored = siwc.private_read(pair_file)
    siwc.private_write(pair_file, {**stored, 'expires_at': 0})
    assert client.post('/v1/pair', headers=auth(), json={'code': code}).status_code == 403
    code = gateway.create_pair_code(vm.storage)
    client.post('/v1/pair', headers=auth(), json={'code': code})
    attempt = client.post('/v1/attempts', headers=auth()).json()
    monkeypatch.setattr(siwc, 'disconnect', lambda _: None)
    assert client.delete('/v1/connection', headers=auth()).status_code == 204
    assert process.terminated
    assert client.get(f"/v1/attempts/{attempt['id']}", headers=auth()).json()['state'] == 'declined'
