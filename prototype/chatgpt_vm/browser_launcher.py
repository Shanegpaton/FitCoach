"""Open approved OAuth pages in the unprivileged VM desktop browser.

This process runs as the desktop user. The gateway and credential store run as
a different user, and only send a URL over this local Unix socket.
"""
from __future__ import annotations

import os
from pathlib import Path
import socket
from urllib.parse import urlsplit

from .siwc import SignInError, open_vm_browser

SOCKET = Path('/run/fitcoach-browser/launch.sock')
MAX_URL_BYTES = 16384


def approved_url(value: str) -> bool:
    parsed = urlsplit(value)
    return (parsed.scheme == 'https' and parsed.netloc == 'auth.openai.com' and
            parsed.path == '/api/accounts/authorize' and bool(parsed.query) and
            not parsed.fragment and not parsed.username and not parsed.password)


def serve(path: Path = SOCKET) -> None:
    path.unlink(missing_ok=True)
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
        listener.bind(str(path))
        os.chmod(path, 0o660)
        listener.listen(4)
        while True:
            connection, _ = listener.accept()
            with connection:
                connection.settimeout(8)
                try:
                    data = bytearray()
                    while len(data) <= MAX_URL_BYTES and not data.endswith(b'\n'):
                        chunk = connection.recv(4096)
                        if not chunk:
                            break
                        data.extend(chunk)
                    if (len(data) > MAX_URL_BYTES or not data.endswith(b'\n') or
                            b'\n' in data[:-1] or b'\r' in data):
                        raise ValueError('Invalid browser request')
                    url = data[:-1].decode('utf-8')
                    if not approved_url(url):
                        raise ValueError('Unapproved browser URL')
                    open_vm_browser(url)
                    connection.sendall(b'OK\n')
                except (OSError, ValueError, UnicodeError, SignInError):
                    try:
                        connection.sendall(b'ERROR\n')
                    except OSError:
                        pass


if __name__ == '__main__':
    serve()
