"""Integration tests require an explicitly disposable PostgreSQL database."""
import os
import asyncio
from pathlib import Path
from uuid import uuid4

import httpx
import pytest
import sqlalchemy as sa
from alembic import command
from alembic.config import Config

from backend.app import create_app
from backend.auth import AuthVerifier
from backend.config import Settings
from backend.setup_checkpointer import main as setup_checkpointer


@pytest.fixture(scope='session')
def migrated_database():
    admin = os.getenv('FITCOACH_TEST_ADMIN_URL')
    runtime = os.getenv('FITCOACH_TEST_DATABASE_URL')
    if not admin or not runtime:
        pytest.skip('Set FITCOACH_TEST_ADMIN_URL and FITCOACH_TEST_DATABASE_URL for real PostgreSQL tests')
    if os.getenv('FITCOACH_TEST_ALLOW_RESET') != 'YES':
        pytest.fail('These tests downgrade the application schema: FITCOACH_TEST_ALLOW_RESET=YES is required')
    previous = {key: os.environ.get(key) for key in ('FITCOACH_MIGRATION_DATABASE_URL', 'FITCOACH_ALLOW_LOCAL_PLAINTEXT')}
    os.environ['FITCOACH_MIGRATION_DATABASE_URL'] = admin
    os.environ['FITCOACH_ALLOW_LOCAL_PLAINTEXT'] = 'true'
    config = Config(str(Path(__file__).parents[1] / 'alembic.ini'))
    command.upgrade(config, 'head')
    asyncio.run(setup_checkpointer())
    engine = sa.create_engine(admin)
    with engine.connect() as connection:
        assert connection.scalar(sa.text('SELECT count(*) FROM fitcoach.exercise_catalog')) == 12
    command.downgrade(config, 'base')
    with engine.connect() as connection:
        assert connection.scalar(sa.text("SELECT to_regnamespace('fitcoach')")) is None
    command.upgrade(config, 'head')
    engine.dispose()
    yield runtime
    for key, value in previous.items():
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value


@pytest.fixture
async def api(migrated_database):
    settings = Settings(database_url=migrated_database, supabase_url='https://auth.example',
                        supabase_key='test-key', pool_size=2, cors_origins=('https://fitcoach.example',),
                        allow_local_plaintext=True)
    app = create_app(settings)
    users = {'a': uuid4(), 'b': uuid4()}
    auth_calls = []

    def auth_response(request):
        assert request.url.path == '/auth/v1/user'
        assert request.headers['apikey'] == 'test-key'
        token = request.headers['Authorization'].removeprefix('Bearer ')
        auth_calls.append(token)
        if token == 'unavailable':
            return httpx.Response(503)
        if token not in users:
            return httpx.Response(401)
        return httpx.Response(200, json={'id': str(users[token])})

    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.MockTransport(auth_response)) as auth_client:
            app.state.auth = AuthVerifier(auth_client, settings.supabase_url, settings.supabase_key)
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://api') as client:
                yield client, app.state.database, users, auth_calls
