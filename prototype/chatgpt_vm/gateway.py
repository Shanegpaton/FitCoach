"""Single-owner, VM-local gateway for the FitCoachGPT sign-in prototype.

Expose only through an HTTPS reverse proxy which protects /browser/* with
GET /v1/browser-auth. OpenAI credentials never leave this process's VM.
"""
from __future__ import annotations

import hashlib
import hmac
import os
from pathlib import Path
import secrets
import subprocess
import sys
import threading
import time
from uuid import UUID, uuid4

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, ConfigDict, Field

from . import siwc


class PairBody(BaseModel):
    model_config = ConfigDict(extra='forbid')
    code: str = Field(min_length=20, max_length=100)


class Gateway:
    def __init__(self, storage: Path, supabase_url: str, supabase_key: str, public_origin: str,
                 pwa_origin: str, verify_user=None, launch_process=None):
        if not public_origin.startswith('https://') or not pwa_origin.startswith('https://'):
            raise ValueError('Public VM and PWA origins must use HTTPS')
        if not supabase_url.startswith('https://') or not supabase_key:
            raise ValueError('Supabase Auth configuration is required')
        self.storage = storage
        siwc.private_dir(storage)
        self.supabase_url = supabase_url.rstrip('/')
        self.supabase_key = supabase_key
        self.public_origin = public_origin.rstrip('/')
        self.pwa_origin = pwa_origin.rstrip('/')
        self.verify_user_override = verify_user
        self.launch_process = launch_process or self._launch_process
        self.lock = threading.RLock()
        self.attempt: dict | None = None
        self.tickets: dict[str, tuple[str, float]] = {}
        self.sessions: dict[str, float] = {}

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

    def owner(self) -> str | None:
        record = siwc.private_read(self.storage / 'owner.json')
        return record['user_id'] if record else None

    def require_owner(self, user_id: str) -> None:
        if self.owner() != user_id:
            raise HTTPException(403, 'This VM is not linked to your FitCoach account')

    def connection(self) -> dict:
        record = siwc.private_read(self.storage / 'credentials.json')
        return {'paired': self.owner() is not None, 'connected': record is not None,
                'email': record.get('email') if record else None,
                'name': record.get('name') if record else None,
                'planUsageGranted': record.get('plan_usage_granted') if record else None}

    @staticmethod
    def _launch_process(storage: Path) -> subprocess.Popen:
        env = os.environ.copy()
        env['DISPLAY'] = ':1'
        env['XAUTHORITY'] = str(Path.home() / '.Xauthority')
        env['BROWSER'] = '/usr/bin/firefox'
        return subprocess.Popen([sys.executable, '-m', 'prototype.chatgpt_vm.siwc',
                                 'sign-in', '--storage', str(storage)],
                                cwd=Path(__file__).resolve().parents[2], env=env,
                                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL, close_fds=True)

    def start(self) -> dict:
        with self.lock:
            if self.attempt and self.attempt['state'] == 'pending':
                raise HTTPException(409, 'A sign-in attempt is already running')
            path = self.storage / 'credentials.json'
            before = path.stat().st_mtime_ns if path.exists() else None
            process = self.launch_process(self.storage)
            attempt_id = str(uuid4())
            ticket = secrets.token_urlsafe(32)
            self.attempt = {'id': attempt_id, 'state': 'pending', 'started': time.time(),
                            'process': process, 'before': before, 'cancelled': False}
            self.tickets[ticket] = (attempt_id, time.time() + 120)
            threading.Thread(target=self._watch, args=(attempt_id,), daemon=True).start()
            return {'id': attempt_id, 'state': 'pending',
                    'launchUrl': f'{self.public_origin}/v1/launch/{ticket}'}

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
            siwc.disconnect(self.storage)
            self.tickets.clear()
            self.sessions.clear()


def create_pair_code(storage: Path) -> str:
    siwc.private_dir(storage)
    if siwc.private_read(storage / 'owner.json'):
        raise ValueError('This VM is already paired')
    code = secrets.token_urlsafe(24)
    siwc.private_write(storage / 'pairing.json', {
        'sha256': hashlib.sha256(code.encode()).hexdigest(), 'expires_at': time.time() + 3600,
    })
    return code


def create_app(gateway: Gateway) -> FastAPI:
    app = FastAPI(title='FitCoachGPT VM sign-in prototype', docs_url=None, redoc_url=None)
    app.add_middleware(CORSMiddleware, allow_origins=[gateway.pwa_origin],
                       allow_methods=['GET', 'POST', 'DELETE'], allow_headers=['Authorization', 'Content-Type'])

    async def user(authorization: str = Header(default='')) -> str:
        return await gateway.verify_user(authorization)

    async def owner(user_id: str = Depends(user)) -> str:
        gateway.require_owner(user_id)
        return user_id

    @app.get('/health')
    async def health():
        return {'status': 'ok'}

    @app.post('/v1/pair')
    async def pair(body: PairBody, user_id: str = Depends(user)):
        with gateway.lock:
            existing = gateway.owner()
            if existing:
                if existing != user_id:
                    raise HTTPException(403, 'This VM is linked to another account')
                return gateway.connection()
            record = siwc.private_read(gateway.storage / 'pairing.json')
            if not record or time.time() >= record['expires_at'] or not hmac.compare_digest(
                    record['sha256'], hashlib.sha256(body.code.encode()).hexdigest()):
                raise HTTPException(403, 'Invalid or expired pairing code')
            siwc.private_write(gateway.storage / 'owner.json', {'user_id': user_id})
            (gateway.storage / 'pairing.json').unlink(missing_ok=True)
            return gateway.connection()

    @app.get('/v1/connection')
    async def connection(user_id: str = Depends(user)):
        linked = gateway.owner()
        if linked and linked != user_id:
            raise HTTPException(403, 'This VM is linked to another account')
        return gateway.connection()

    @app.post('/v1/attempts')
    async def start(_: str = Depends(owner)):
        return gateway.start()

    @app.get('/v1/attempts/{attempt_id}')
    async def attempt(attempt_id: str, _: str = Depends(owner)):
        with gateway.lock:
            current = gateway.attempt
            if not current or current['id'] != attempt_id:
                raise HTTPException(404, 'Attempt not found')
            return {'id': attempt_id, 'state': current['state'], 'connection': gateway.connection()}

    @app.delete('/v1/connection', status_code=204)
    async def disconnect(_: str = Depends(owner)):
        gateway.stop()
        return Response(status_code=204)

    @app.get('/v1/launch/{ticket}')
    async def launch(ticket: str):
        with gateway.lock:
            entry = gateway.tickets.pop(ticket, None)
            if (not entry or time.time() > entry[1] or not gateway.attempt or
                    entry[0] != gateway.attempt['id'] or gateway.attempt['state'] != 'pending'):
                raise HTTPException(404, 'Launch link expired')
            session = secrets.token_urlsafe(32)
            gateway.sessions[session] = time.time() + 600
        response = RedirectResponse('/browser/vnc.html?autoconnect=1&path=browser/websockify', status_code=303)
        response.set_cookie('fitcoach_vm_browser', session, max_age=600, path='/browser',
                            secure=True, httponly=True, samesite='lax')
        return response

    @app.get('/v1/browser-auth')
    async def browser_auth(request: Request):
        token = request.cookies.get('fitcoach_vm_browser', '')
        with gateway.lock:
            expires = gateway.sessions.get(token)
            if not expires or time.time() >= expires:
                raise HTTPException(401, 'Browser session expired')
        return Response(status_code=204)

    return app


def main() -> None:
    import argparse
    import uvicorn
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['serve', 'pair-code'])
    parser.add_argument('--storage', type=Path,
                        default=Path.home() / '.config' / 'fitcoach-siwc-prototype')
    args = parser.parse_args()
    if args.action == 'pair-code':
        print(create_pair_code(args.storage))
        return
    gateway = Gateway(args.storage, os.environ['FITCOACH_VM_SUPABASE_URL'],
                      os.environ['FITCOACH_VM_SUPABASE_KEY'],
                      os.environ['FITCOACH_VM_PUBLIC_ORIGIN'], os.environ['FITCOACH_VM_PWA_ORIGIN'])
    uvicorn.run(create_app(gateway), host='127.0.0.1', port=8787, access_log=False)


if __name__ == '__main__':
    main()
