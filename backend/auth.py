"""Token verification via Supabase Auth only; no REST database client."""
import logging
from uuid import UUID

import httpx
from fastapi import HTTPException, Request

logger = logging.getLogger(__name__)


class AuthVerifier:
    def __init__(self, client: httpx.AsyncClient, url: str, key: str):
        self.client, self.url, self.key = client, url.rstrip('/'), key

    async def verify(self, token: str) -> UUID:
        try:
            response = await self.client.get(f'{self.url}/auth/v1/user', headers={
                'Authorization': f'Bearer {token}', 'apikey': self.key,
            })
        except httpx.RequestError:
            logger.warning('Supabase Auth user verification request failed')
            raise HTTPException(503, 'Authentication unavailable') from None
        if response.status_code in (401, 403):
            raise HTTPException(401, 'Invalid or expired token', headers={'WWW-Authenticate': 'Bearer'})
        if response.status_code != 200:
            logger.warning('Supabase Auth user verification returned HTTP %s', response.status_code)
            raise HTTPException(503, 'Authentication unavailable')
        try:
            return UUID(response.json()['id'])
        except (ValueError, KeyError, TypeError):
            raise HTTPException(503, 'Invalid authentication response') from None


async def identity(request: Request) -> UUID:
    authorization = request.headers.get('Authorization', '')
    parts = authorization.split()
    if len(parts) != 2 or parts[0].lower() != 'bearer':
        raise HTTPException(401, 'Bearer token required', headers={'WWW-Authenticate': 'Bearer'})
    return await request.app.state.auth.verify(parts[1])
