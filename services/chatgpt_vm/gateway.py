"""Exclusive-lease VM gateway for the FitCoachGPT sign-in service."""
from __future__ import annotations

import hashlib
import hmac
import asyncio
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import threading
import time
from urllib.parse import urlsplit
from uuid import UUID, uuid4

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException, Response, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field

from . import siwc


class HandoffBody(BaseModel):
    model_config = ConfigDict(extra='forbid')
    code: str = Field(min_length=40, max_length=100)


class Gateway:
    def __init__(self, storage: Path, supabase_url: str, supabase_key: str, public_origin: str,
                 pwa_origin: str, verify_user=None, launch_process=None, reset_browser=None):
        pwa_origins = [origin.strip().rstrip('/') for origin in pwa_origin.split(',') if origin.strip()]
        if not public_origin.startswith('https://') or not pwa_origins or any(
                (parsed := urlsplit(origin)).scheme != 'https' or not parsed.netloc or
                parsed.path or parsed.query or parsed.fragment or parsed.username or parsed.password
                for origin in pwa_origins):
            raise ValueError('Public VM and PWA origins must use HTTPS')
        if not supabase_url.startswith('https://') or not supabase_key:
            raise ValueError('Supabase Auth configuration is required')
        self.storage = storage
        siwc.private_dir(storage)
        self.supabase_url = supabase_url.rstrip('/')
        self.supabase_key = supabase_key
        self.public_origin = public_origin.rstrip('/')
        self.pwa_origins = pwa_origins
        self.verify_user_override = verify_user
        self.launch_process = launch_process or self._launch_process
        self.reset_browser = reset_browser or self._reset_browser
        self.lock = threading.RLock()
        self.attempt: dict | None = None
        self.viewers: dict[str, tuple[str, float]] = {}
        self.handoffs: dict[str, tuple[str, float]] = {}

    async def verify_user(self, authorization: str) -> str:
        parts = authorization.split()
        if len(parts) != 2 or parts[0].lower() != 'bearer':
            raise HTTPException(401, 'Bearer token required')
        if self.verify_user_override:
            return str(UUID(await self.verify_user_override(parts[1])))
        try:
            async with httpx.AsyncClient(timeout=10, follow_redirects=False) as client:
                result = await client.get(f'{self.supabase_url}/auth/v1/user', headers={
                    'Authorization': f'Bearer {parts[1]}', 'apikey': self.supabase_key,
                })
        except httpx.RequestError:
            raise HTTPException(503, 'Authentication unavailable') from None
        if result.status_code in (401, 403):
            raise HTTPException(401, 'Invalid or expired token')
        if result.status_code != 200:
            raise HTTPException(503, 'Authentication unavailable')
        try:
            return str(UUID(result.json()['id']))
        except (KeyError, TypeError, ValueError):
            raise HTTPException(503, 'Invalid authentication response') from None

    @staticmethod
    def _reset_browser() -> None:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(10)
            client.connect('/run/fitcoach-browser/launch.sock')
            client.sendall(b'RESET\n')
            if client.recv(32) != b'OK\n':
                raise OSError('Browser cleanup failed')

    def owner(self) -> str | None:
        with self.lock:
            record = siwc.private_read(self.storage / 'owner.json')
            stale_legacy = (record and 'expires_at' not in record and
                            not (self.storage / 'credentials.json').exists() and
                            not (self.attempt and self.attempt['state'] == 'pending'))
            expired = record and time.time() >= record.get('expires_at', float('inf')) + (
                120 if self.attempt and self.attempt['state'] == 'connected' else 0)
            if stale_legacy or expired:
                try:
                    self._release()
                except OSError:
                    raise HTTPException(503, 'The VM browser could not be cleared') from None
                return None
            return record['user_id'] if record else None

    def _release(self) -> None:
        attempt = self.attempt
        if attempt and attempt['state'] == 'pending':
            attempt['cancelled'] = True
            attempt['process'].terminate()
            try:
                attempt['process'].wait(timeout=5)
            except subprocess.TimeoutExpired:
                attempt['process'].kill()
                attempt['process'].wait(timeout=5)
            attempt['state'] = 'declined'
        # Fail closed: another account cannot enter until browser state is gone.
        self.reset_browser()
        (self.storage / 'credentials.json').unlink(missing_ok=True)
        (self.storage / 'host.json').unlink(missing_ok=True)
        (self.storage / 'owner.json').unlink(missing_ok=True)
        self.attempt = None
        self.viewers.clear()
        self.handoffs.clear()

    def require_owner(self, user_id: str) -> None:
        if self.owner() != user_id:
            raise HTTPException(403, 'This VM session belongs to another account or has expired')

    def connection(self, user_id: str | None = None) -> dict:
        record = siwc.private_read(self.storage / 'credentials.json')
        owner = self.owner()
        if owner != user_id:
            record = None
        return {'paired': owner == user_id, 'busy': owner is not None and owner != user_id,
                'connected': record is not None,
                'email': record.get('email') if record else None,
                'name': record.get('name') if record else None,
                'planUsageGranted': record.get('plan_usage_granted') if record else None}

    def issue_handoff(self, user_id: str) -> dict:
        with self.lock:
            self.require_owner(user_id)
            if not siwc.private_read(self.storage / 'credentials.json'):
                raise HTTPException(409, 'Connect ChatGPT before saving this session')
            code = secrets.token_urlsafe(48)
            self.handoffs[hashlib.sha256(code.encode()).hexdigest()] = (user_id, time.time() + 120)
            return {'code': code}

    def redeem_handoff(self, user_id: str, code: str, key: str) -> dict:
        configured = os.environ.get('FITCOACH_VM_HANDOFF_KEY', '')
        if len(configured) < 32 or not hmac.compare_digest(key, configured):
            raise HTTPException(403, 'Handoff service authentication failed')
        with self.lock:
            self.require_owner(user_id)
            entry = self.handoffs.pop(hashlib.sha256(code.encode()).hexdigest(), None)
            if not entry or entry[0] != user_id or time.time() >= entry[1]:
                raise HTTPException(404, 'Handoff expired or already used')
            record = siwc.private_read(self.storage / 'credentials.json')
            if not record:
                raise HTTPException(409, 'ChatGPT connection unavailable')
            return {'userId': user_id, 'credentials': record}

    @staticmethod
    def _launch_process(storage: Path) -> subprocess.Popen:
        env = os.environ.copy()
        env['FITCOACH_VM_BROWSER_SOCKET'] = '/run/fitcoach-browser/launch.sock'
        return subprocess.Popen([sys.executable, '-m', 'services.chatgpt_vm.siwc',
                                 'sign-in', '--storage', str(storage)],
                                cwd=Path(__file__).resolve().parents[2], env=env,
                                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL, close_fds=True)

    def start(self, user_id: str) -> dict:
        with self.lock:
            current = self.owner()
            if current and current != user_id:
                raise HTTPException(409, 'The VM is in use. Try again in a few minutes.')
            if self.attempt and self.attempt['state'] == 'pending':
                self.viewers.clear()
                viewer = secrets.token_urlsafe(32)
                lease = siwc.private_read(self.storage / 'owner.json')
                self.viewers[viewer] = (self.attempt['id'], min(lease.get('expires_at', time.time() + 300), time.time() + 300))
                return {'id': self.attempt['id'], 'state': 'pending', 'viewerToken': viewer}
            if current and siwc.private_read(self.storage / 'credentials.json'):
                raise HTTPException(409, 'Save the completed connection before starting again')
            if current is None:
                if (self.storage / 'credentials.json').exists():
                    raise HTTPException(503, 'An unclaimed VM credential needs operator recovery')
                try:
                    self.reset_browser()
                except OSError:
                    raise HTTPException(503, 'The VM browser could not be cleared') from None
                siwc.private_write(self.storage / 'owner.json',
                                   {'user_id': user_id, 'expires_at': time.time() + 300})
            else:
                try:
                    self.reset_browser()
                except OSError:
                    raise HTTPException(503, 'The VM browser could not be cleared') from None
            path = self.storage / 'credentials.json'
            before = path.stat().st_mtime_ns if path.exists() else None
            try:
                process = self.launch_process(self.storage)
            except OSError:
                self._release()
                raise HTTPException(503, 'The VM sign-in service could not start') from None
            attempt_id = str(uuid4())
            self.attempt = {'id': attempt_id, 'state': 'pending', 'started': time.time(),
                            'process': process, 'before': before, 'cancelled': False}
            viewer = secrets.token_urlsafe(32)
            lease = siwc.private_read(self.storage / 'owner.json')
            self.viewers[viewer] = (attempt_id, lease.get('expires_at', time.time() + 300))
            threading.Thread(target=self._watch, args=(attempt_id,), daemon=True).start()
            return {'id': attempt_id, 'state': 'pending', 'viewerToken': viewer}

    def _watch(self, attempt_id: str) -> None:
        with self.lock:
            attempt = self.attempt
            if not attempt or attempt['id'] != attempt_id:
                return
            process = attempt['process']
        exit_code = process.wait()
        with self.lock:
            if not self.attempt or self.attempt['id'] != attempt_id:
                return
            attempt = self.attempt
            if attempt['cancelled']:
                attempt['state'] = 'declined'
            else:
                path = self.storage / 'credentials.json'
                changed = path.exists() and path.stat().st_mtime_ns != attempt['before']
                if exit_code == 0 and changed:
                    attempt['state'] = 'connected'
                elif exit_code == 0:
                    attempt['state'] = 'declined'
                elif time.time() - attempt['started'] >= siwc.TIMEOUT_SECONDS:
                    attempt['state'] = 'expired'
                else:
                    attempt['state'] = 'failed'

    def stop(self) -> None:
        with self.lock:
            try:
                self._release()
            except OSError:
                raise HTTPException(503, 'The VM browser could not be cleared') from None


def create_app(gateway: Gateway) -> FastAPI:
    app = FastAPI(title='FitCoachGPT VM sign-in service', docs_url=None, redoc_url=None)
    app.add_middleware(CORSMiddleware, allow_origins=gateway.pwa_origins,
                       allow_methods=['GET', 'POST', 'DELETE'], allow_headers=['Authorization', 'Content-Type'])

    async def user(authorization: str = Header(default='')) -> str:
        return await gateway.verify_user(authorization)

    async def owner(user_id: str = Depends(user)) -> str:
        gateway.require_owner(user_id)
        return user_id

    @app.get('/health')
    async def health():
        return {'status': 'ok'}

    @app.get('/v1/connection')
    async def connection(user_id: str = Depends(user)):
        with gateway.lock:
            return gateway.connection(user_id)

    @app.post('/v1/handoff')
    async def issue_handoff(user_id: str = Depends(owner)):
        return gateway.issue_handoff(user_id)

    @app.post('/v1/handoff/redeem')
    async def redeem_handoff(body: HandoffBody, user_id: str = Depends(owner),
                             x_fitcoach_handoff_key: str = Header(default='')):
        return gateway.redeem_handoff(user_id, body.code, x_fitcoach_handoff_key)

    @app.post('/v1/handoff/confirm', status_code=204)
    async def confirm_handoff(user_id: str = Depends(owner),
                              x_fitcoach_handoff_key: str = Header(default='')):
        configured = os.environ.get('FITCOACH_VM_HANDOFF_KEY', '')
        if len(configured) < 32 or not hmac.compare_digest(x_fitcoach_handoff_key, configured):
            raise HTTPException(403, 'Handoff service authentication failed')
        gateway.stop()
        return Response(status_code=204)

    @app.post('/v1/attempts')
    async def start(user_id: str = Depends(user)):
        return gateway.start(user_id)

    @app.get('/v1/attempts/{attempt_id}')
    async def attempt(attempt_id: str, _: str = Depends(owner)):
        with gateway.lock:
            current = gateway.attempt
            if not current or current['id'] != attempt_id:
                raise HTTPException(404, 'Attempt not found')
            return {'id': attempt_id, 'state': current['state'], 'connection': gateway.connection(_)}

    @app.delete('/v1/connection', status_code=204)
    async def disconnect(_: str = Depends(owner)):
        gateway.stop()
        return Response(status_code=204)

    @app.websocket('/v1/viewer')
    async def viewer(websocket: WebSocket):
        origin = websocket.headers.get('origin', '')
        protocols = websocket.scope.get('subprotocols', [])
        token = next((p.removeprefix('fitcoach.') for p in protocols
                      if p.startswith('fitcoach.')), '')
        with gateway.lock:
            entry = gateway.viewers.get(token)
            allowed = (origin in gateway.pwa_origins and entry is not None and
                       time.time() < entry[1] and gateway.attempt is not None and
                       gateway.attempt['id'] == entry[0] and
                       gateway.attempt['state'] == 'pending')
        if not allowed:
            await websocket.close(code=1008)
            return
        try:
            reader, writer = await asyncio.open_connection('127.0.0.1', 5901)
        except OSError:
            await websocket.close(code=1011)
            return
        await websocket.accept()

        async def to_browser():
            while data := await reader.read(65536):
                with gateway.lock:
                    if (gateway.viewers.get(token) != entry or gateway.attempt is None or
                            gateway.attempt['id'] != entry[0] or gateway.attempt['state'] != 'pending'):
                        return
                await websocket.send_bytes(data)

        async def to_vm():
            while True:
                message = await websocket.receive()
                if message['type'] == 'websocket.disconnect':
                    return
                with gateway.lock:
                    if (gateway.viewers.get(token) != entry or gateway.attempt is None or
                            gateway.attempt['id'] != entry[0] or gateway.attempt['state'] != 'pending'):
                        return
                if message.get('bytes') is not None:
                    writer.write(message['bytes'])
                    await writer.drain()

        async def expire():
            while True:
                with gateway.lock:
                    if (gateway.viewers.get(token) != entry or gateway.attempt is None or
                            gateway.attempt['id'] != entry[0] or gateway.attempt['state'] != 'pending' or
                            time.time() >= entry[1]):
                        return
                await asyncio.sleep(0.25)

        tasks = [asyncio.create_task(to_browser()), asyncio.create_task(to_vm()),
                 asyncio.create_task(expire())]
        try:
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                try:
                    task.result()
                except (OSError, WebSocketDisconnect):
                    pass  # Closing the in-app viewer interrupts the outgoing VNC stream.
        finally:
            for task in tasks:
                task.cancel()
            writer.close()
            await writer.wait_closed()
            try:
                await websocket.close()
            except (OSError, RuntimeError, WebSocketDisconnect):
                pass

    return app


def main() -> None:
    import argparse
    import uvicorn
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['serve'])
    parser.add_argument('--storage', type=Path,
                        default=Path.home() / '.config' / 'fitcoach-siwc-prototype')
    args = parser.parse_args()
    gateway = Gateway(args.storage, os.environ['FITCOACH_VM_SUPABASE_URL'],
                      os.environ['FITCOACH_VM_SUPABASE_KEY'],
                      os.environ['FITCOACH_VM_PUBLIC_ORIGIN'], os.environ['FITCOACH_VM_PWA_ORIGIN'])
    uvicorn.run(create_app(gateway), host='127.0.0.1', port=8787, access_log=False)


if __name__ == '__main__':
    main()
