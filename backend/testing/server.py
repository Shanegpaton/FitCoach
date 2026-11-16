"""Real API/SQL database, with only external Supabase identity mocked.

Run via `python -m backend.testing.server`. Binds loopback only. Requires an
explicitly disposable, loopback database and reset acknowledgment. Never deploy.
"""
import asyncio
import os
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
import uvicorn
from alembic import command
from alembic.config import Config
from sqlalchemy.engine import make_url

from backend.app import create_app
from backend.auth import AuthVerifier
from backend.config import Settings
from backend.setup_checkpointer import main as setup_checkpointer
from backend.testing.database import clear_training_data

USER_A = '11111111-1111-4111-8111-111111111111'
USER_B = '22222222-2222-4222-8222-222222222222'


def disposable_urls():
    if os.getenv('FITCOACH_TEST_ALLOW_RESET') != 'YES':
        raise RuntimeError('FITCOACH_TEST_ALLOW_RESET=YES is required for this disposable harness')
    urls = [os.environ[key] for key in ('FITCOACH_TEST_ADMIN_URL', 'FITCOACH_TEST_DATABASE_URL')]
    for value in urls:
        url = make_url(value)
        if url.host not in ('localhost', '127.0.0.1', '::1') or url.database != 'fitcoach_test':
            raise RuntimeError('Harness accepts only loopback PostgreSQL database named fitcoach_test')
    if any(getattr(make_url(urls[0]), key) != getattr(make_url(urls[1]), key) for key in ('host', 'port', 'database', 'drivername')):
        raise RuntimeError('Admin and runtime URLs must target the same database')
    return urls


def auth_response(request):
    token = request.headers.get('Authorization', '').removeprefix('Bearer ')
    users = {'test-a': USER_A, 'test-b': USER_B}
    return httpx.Response(200, json={'id': users[token]}) if token in users else httpx.Response(401)


def main():
    admin, runtime = disposable_urls()
    os.environ['FITCOACH_MIGRATION_DATABASE_URL'] = admin
    os.environ['FITCOACH_ALLOW_LOCAL_PLAINTEXT'] = 'true'
    config = Config(str(Path(__file__).parents[1] / 'alembic.ini'))
    clear_training_data(admin)
    command.downgrade(config, 'base')
    command.upgrade(config, 'head')
    asyncio.run(setup_checkpointer())
    settings = Settings(database_url=runtime, supabase_url='https://auth.example', supabase_key='test-only',
                        allow_local_plaintext=True, cors_origins=('http://localhost:4175',))
    app = create_app(settings)
    original = app.router.lifespan_context

    @asynccontextmanager
    async def lifespan(application):
        async with original(application):
            async with httpx.AsyncClient(transport=httpx.MockTransport(auth_response)) as client:
                application.state.auth = AuthVerifier(client, settings.supabase_url, settings.supabase_key)
                yield

    app.router.lifespan_context = lifespan
    uvicorn.run(app, host='127.0.0.1', port=8001, log_level='info')


if __name__ == '__main__':
    main()
