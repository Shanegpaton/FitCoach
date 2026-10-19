import socket
import threading
import tempfile
from pathlib import Path

import pytest

from prototype.chatgpt_vm import browser_launcher, siwc


@pytest.mark.parametrize('url', [
    'http://auth.openai.com/api/accounts/authorize?x=1',
    'https://auth.openai.com.evil.test/api/accounts/authorize?x=1',
    'https://auth.openai.com/other?x=1',
    'https://auth.openai.com/api/accounts/authorize',
    'https://auth.openai.com/api/accounts/authorize?x=1#fragment',
    'file:///var/lib/fitcoach-auth/state/credentials.json',
])
def test_launcher_rejects_other_urls(url):
    assert not browser_launcher.approved_url(url)


def test_authorization_url_is_approved():
    url = siwc.authorization_url(host='urn:uuid:test', redirect_uri='http://127.0.0.1:1234/auth/callback',
                                 state='state', nonce='nonce', verifier='verifier', saved=None)
    assert browser_launcher.approved_url(url)


def test_protected_sign_in_delegates_browser_open_to_socket(monkeypatch):
    directory = tempfile.TemporaryDirectory(prefix='fc-', dir='/tmp')
    path = Path(directory.name) / 'launcher.sock'
    received = []
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
            try:
                listener.bind(str(path))
            except PermissionError:
                pytest.skip('This sandbox does not permit Unix sockets')
            listener.listen(1)

            def server():
                connection, _ = listener.accept()
                with connection:
                    received.append(connection.recv(1000))
                    connection.sendall(b'OK\n')

            worker = threading.Thread(target=server)
            worker.start()
            monkeypatch.setenv('FITCOACH_VM_BROWSER_SOCKET', str(path))
            siwc.open_vm_browser('https://auth.openai.com/api/accounts/authorize?x=1')
            worker.join(timeout=2)
            assert received == [b'https://auth.openai.com/api/accounts/authorize?x=1\n']
    finally:
        directory.cleanup()
