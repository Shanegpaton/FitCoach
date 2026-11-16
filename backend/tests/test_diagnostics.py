from uuid import UUID

import httpx
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.diagnostics import register_diagnostics


async def test_request_ids_are_generated_even_for_failures_without_leaking_errors(caplog):
    app = FastAPI()
    register_diagnostics(app)
    app.add_middleware(CORSMiddleware, allow_origins=['https://fitcoach.example'], expose_headers=['X-Request-ID'])

    @app.get('/boom/{item}')
    async def boom(item: str):
        raise ValueError('secret-token-and-health-notes')

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        response = await client.get('/boom/private-id?token=secret', headers={'X-Request-ID': 'injected', 'Origin': 'https://fitcoach.example'})
    assert response.status_code == 500
    assert UUID(response.headers['X-Request-ID'])
    assert response.headers['access-control-allow-origin'] == 'https://fitcoach.example'
    assert response.json() == {'detail': 'An unexpected error occurred'}
    assert 'secret-token' not in caplog.text
    assert 'private-id' not in caplog.text


async def test_browser_diagnostics_are_authenticated_and_reject_free_text(api):
    client, _, _, _ = api
    event = {'code': 'render_error', 'at': '2026-01-01T00:00:00Z', 'status': 500}
    assert (await client.post('/v1/diagnostics', json=event)).status_code == 401
    accepted = await client.post('/v1/diagnostics', headers={'Authorization': 'Bearer a'}, json=event)
    assert accepted.status_code == 204
    assert UUID(accepted.headers['X-Request-ID'])
    rejected = await client.post('/v1/diagnostics', headers={'Authorization': 'Bearer a'}, json={**event, 'message': 'private'})
    assert rejected.status_code == 422
    cors = await client.get('/health', headers={'Origin': 'https://fitcoach.example'})
    assert 'X-Request-ID' in cors.headers['access-control-expose-headers']
