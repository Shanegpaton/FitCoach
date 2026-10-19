"""Disposable, single-user VM proof of the OpenAI loopback sign-in path.

This module is deliberately separate from the training API and PWA. Run it only
inside the VM whose interactive browser will follow the loopback redirect.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import threading
import time
from urllib.parse import parse_qs, urlencode, urlsplit
from uuid import uuid4

import httpx

ISSUER = 'https://auth.openai.com'
AUTHORIZE = f'{ISSUER}/api/accounts/authorize'
TOKEN = f'{ISSUER}/api/accounts/oauth/token'
JWKS = f'{ISSUER}/.well-known/jwks.json'
DISCOVERY = f'{ISSUER}/.well-known/openid-configuration'
RESOURCE = 'https://api.openai.com/v1'
SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'
CALLBACK_PATH = '/auth/callback'
TIMEOUT_SECONDS = 300


class SignInError(Exception):
    pass


def private_dir(path: Path) -> None:
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    if path.is_symlink() or path.stat().st_mode & 0o077:
        raise SignInError('Credential directory must be owner-only and cannot be a symlink')


def private_write(path: Path, data: dict) -> None:
    private_dir(path.parent)
    temporary = path.with_name(f'.{path.name}.{secrets.token_hex(8)}')
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, 'w') as output:
            json.dump(data, output)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def private_read(path: Path) -> dict | None:
    if not path.exists():
        return None
    if path.is_symlink() or path.stat().st_mode & 0o077:
        raise SignInError('Credential file must be owner-only and cannot be a symlink')
    with path.open() as source:
        return json.load(source)


def host_id(path: Path) -> str:
    current = private_read(path)
    if current:
        return current['ext_agent_host_id']
    value = f'urn:uuid:{uuid4()}'
    private_write(path, {'ext_agent_host_id': value})
    return value


def challenge(verifier: str) -> str:
    return base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b'=').decode()


def authorization_url(*, host: str, redirect_uri: str, state: str, nonce: str,
                      verifier: str, saved: dict | None) -> str:
    params = {
        'client_id': saved['client_id'] if saved else 'dynamic_agent_client',
        'ext_agent_host_id': host,
        'response_type': 'code', 'redirect_uri': redirect_uri,
        'scope': SCOPES, 'resource': RESOURCE, 'state': state, 'nonce': nonce,
        'code_challenge_method': 'S256', 'code_challenge': challenge(verifier),
    }
    if saved:
        if saved.get('email'):
            params['login_hint'] = saved['email']
    else:
        params['agent_name_hint'] = 'FitCoachGPT'
    return f'{AUTHORIZE}?{urlencode(params)}'


def callback_result(query: str, expected_state: str, saved: dict | None) -> tuple[str, str] | None:
    values = parse_qs(query, strict_parsing=True)
    one = lambda key: values.get(key, [None]) if len(values.get(key, [])) == 1 else [None]
    if not hmac.compare_digest(one('state')[0] or '', expected_state):
        raise SignInError('OAuth state mismatch')
    if one('error')[0]:
        if one('error')[0] == 'access_denied':
            return None
        raise SignInError('Authorization failed')
    code = one('code')[0]
    issued = one('client_id')[0]
    if not code:
        raise SignInError('Missing authorization code')
    if saved:
        if issued and issued != saved['client_id']:
            raise SignInError('Registration changed during reconnection')
        issued = saved['client_id']
    elif not issued or issued == 'dynamic_agent_client' or not issued.startswith('oaiapp_'):
        raise SignInError('New registration did not return an issued client ID')
    return code, issued


def verify_identity(token: str, client_id: str, nonce: str, jwks_url: str = JWKS) -> dict:
    import jwt
    from jwt import PyJWKClient

    key = PyJWKClient(jwks_url).get_signing_key_from_jwt(token).key
    claims = jwt.decode(token, key, algorithms=['RS256'], issuer=ISSUER,
                        audience=client_id, options={'require': ['iss', 'aud', 'exp', 'iat', 'sub', 'nonce']},
                        leeway=5)
    if not hmac.compare_digest(str(claims['nonce']), nonce) or not claims['sub']:
        raise SignInError('ID token nonce or subject is invalid')
    return claims


def exchange(code: str, client_id: str, verifier: str, redirect_uri: str) -> dict:
    with httpx.Client(timeout=15) as client:
        response = client.post(TOKEN, data={
            'grant_type': 'authorization_code', 'client_id': client_id,
            'code': code, 'code_verifier': verifier, 'redirect_uri': redirect_uri,
            'resource': RESOURCE,
        })
        response.raise_for_status()
        return response.json()


def credential_record(tokens: dict, claims: dict, client_id: str, host: str, saved: dict | None) -> dict:
    if saved and (saved['subject'] != claims['sub'] or saved['client_id'] != client_id):
        raise SignInError('Reconnected ChatGPT account does not match the saved account')
    if not all(isinstance(tokens.get(key), str) and tokens[key] for key in
               ('access_token', 'refresh_token', 'id_token', 'scope')):
        raise SignInError('Token response is incomplete')
    scopes = tokens['scope'].split()
    if not {'openid', 'profile', 'email', 'offline_access'}.issubset(scopes):
        raise SignInError('Required identity or renewable-session scope was not granted')
    return {
        'issuer': ISSUER, 'subject': claims['sub'], 'client_id': client_id,
        'ext_agent_host_id': host, 'email': claims.get('email'), 'name': claims.get('name'),
        'access_token': tokens['access_token'], 'refresh_token': tokens['refresh_token'],
        'id_token': tokens['id_token'], 'scopes': scopes,
        'plan_usage_granted': 'chatgpt.tokens.use.direct' in scopes,
        'expires_at': int(time.time()) + int(tokens.get('expires_in', 0)),
    }


def listen_for_callback() -> tuple[HTTPServer, threading.Event, dict]:
    done = threading.Event()
    result: dict = {}

    class Callback(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass  # Query strings contain authorization codes; never log them.

        def do_GET(self):
            parsed = urlsplit(self.path)
            if parsed.path != CALLBACK_PATH or done.is_set():
                self.send_error(404)
                return
            result['query'] = parsed.query
            done.set()
            content = b'<h1>FitCoachGPT sign-in received</h1><p>Return to the VM session for the verified result.</p>'
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(content)

    server = HTTPServer(('127.0.0.1', 0), Callback)
    return server, done, result


def open_vm_browser(url: str) -> None:
    launcher = os.environ.get('FITCOACH_VM_BROWSER_SOCKET')
    if launcher:
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                client.settimeout(6)
                client.connect(launcher)
                client.sendall(url.encode('utf-8') + b'\n')
                if client.recv(32) != b'OK\n':
                    raise SignInError('The VM browser could not start')
        except OSError as exc:
            raise SignInError('The VM browser could not start') from exc
        return
    profile = Path(os.environ.get('FITCOACH_VM_FIREFOX_PROFILE',
                                  Path.home() / '.local/share/fitcoach-firefox-profile'))
    profile.mkdir(mode=0o700, parents=True, exist_ok=True)
    if profile.is_symlink() or profile.stat().st_mode & 0o077:
        raise SignInError('Firefox profile must be owner-only and cannot be a symlink')
    try:
        process = subprocess.Popen([os.environ.get('FITCOACH_VM_FIREFOX', '/usr/bin/firefox-esr'),
                                    '--profile', str(profile),
                                    '--new-window', url], stdin=subprocess.DEVNULL,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                   close_fds=True)
    except OSError as exc:
        raise SignInError('The VM browser could not start') from exc
    try:
        exit_code = process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        return  # A new Firefox process stays running while the user signs in.
    if exit_code != 0:
        raise SignInError('The VM browser could not start')


def sign_in(storage: Path) -> None:
    private_dir(storage)
    host = host_id(storage / 'host.json')
    saved = private_read(storage / 'credentials.json')
    server, done, result = listen_for_callback()
    redirect_uri = f'http://127.0.0.1:{server.server_port}{CALLBACK_PATH}'
    state, nonce, verifier = (secrets.token_urlsafe(32) for _ in range(3))
    url = authorization_url(host=host, redirect_uri=redirect_uri, state=state,
                            nonce=nonce, verifier=verifier, saved=saved)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        open_vm_browser(url)
        print('Complete authorization in the VM browser. Waiting up to five minutes for its loopback callback.')
        if not done.wait(TIMEOUT_SECONDS):
            raise SignInError('Authorization timed out')
        callback = callback_result(result['query'], state, saved)
        if callback is None:
            print('Authorization declined; saved credentials were left intact.')
            return
        code, client_id = callback
        tokens = exchange(code, client_id, verifier, redirect_uri)
        claims = verify_identity(tokens['id_token'], client_id, nonce)
        record = credential_record(tokens, claims, client_id, host, saved)
        private_write(storage / 'credentials.json', record)
        print(json.dumps({'email': record['email'], 'subject': record['subject'],
                          'plan_usage_granted': record['plan_usage_granted']}, indent=2))
    finally:
        server.shutdown()
        server.server_close()


def disconnect(storage: Path) -> None:
    path = storage / 'credentials.json'
    saved = private_read(path)
    if not saved:
        print('No connected account.')
        return
    revoked = False
    try:
        with httpx.Client(timeout=15) as client:
            discovery = client.get(DISCOVERY)
            discovery.raise_for_status()
            endpoint = discovery.json()['revocation_endpoint']
            if not endpoint.startswith(f'{ISSUER}/'):
                raise SignInError('Unexpected revocation endpoint')
            response = client.post(endpoint, data={'token': saved['refresh_token'],
                'token_type_hint': 'refresh_token', 'client_id': saved['client_id']})
            revoked = response.status_code == 200
    except (httpx.HTTPError, KeyError, SignInError):
        pass
    path.unlink()
    print('Local credentials cleared.' + ('' if revoked else ' Remote revocation was not confirmed; disconnect in ChatGPT Settings.'))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['sign-in', 'status', 'disconnect'])
    parser.add_argument('--storage', type=Path, default=Path.home() / '.config' / 'fitcoach-siwc-prototype')
    args = parser.parse_args()
    try:
        if args.action == 'sign-in':
            sign_in(args.storage)
        elif args.action == 'disconnect':
            disconnect(args.storage)
        else:
            saved = private_read(args.storage / 'credentials.json')
            print(json.dumps({'connected': bool(saved), 'email': saved.get('email') if saved else None,
                              'plan_usage_granted': saved.get('plan_usage_granted') if saved else None}))
    except Exception as error:
        # Avoid exception details from HTTP responses or OAuth URLs in user-facing output.
        raise SystemExit(f'Sign-in failed: {type(error).__name__}') from None


if __name__ == '__main__':
    main()
