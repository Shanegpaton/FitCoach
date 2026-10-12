import os
from uuid import uuid4

import pytest
import sqlalchemy as sa
from sqlalchemy.exc import DBAPIError, IntegrityError

from backend import schema as s
from backend.config import Settings
from backend.database import Database, set_identity
from backend.tests.fixtures import headers, override, plan, profile, session
from backend.tests.test_api import put


async def populated(api):
    client, db, users, _ = api
    assert (await put(client, 'profile', profile())).status_code == 201
    assert (await put(client, 'plans', plan())).status_code == 201
    assert (await put(client, 'sessions', session())).status_code == 201
    assert (await put(client, 'schedule-overrides', override())).status_code == 201
    return client, db, users


async def test_every_table_forces_rls_and_missing_context_denies(api):
    _, db, users = await populated(api)
    async with db.sessions() as transaction, transaction.begin():
        # A pooled connection used by previous HTTP requests must have no identity.
        context = await transaction.scalar(sa.text("SELECT NULLIF(current_setting('app.user_id', true), '')"))
        assert context is None
        for table in s.OWNED_TABLES:
            assert await transaction.scalar(sa.select(sa.func.count()).select_from(table)) == 0
        await set_identity(transaction, users['a'])
        for table in s.OWNED_TABLES:
            assert await transaction.scalar(sa.select(sa.func.count()).select_from(table)) > 0
        assert await transaction.scalar(sa.select(sa.func.count()).select_from(s.sync_state)) == 1
        assert await transaction.scalar(sa.select(sa.func.count()).select_from(s.mutation_receipts)) == 0
        assert await transaction.scalar(sa.text('''
            SELECT bool_and(c.relrowsecurity AND c.relforcerowsecurity)
            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'fitcoach' AND c.relname <> 'exercise_catalog' AND c.relkind = 'r'
        ''')) is True
        assert await transaction.scalar(sa.text('''
            SELECT bool_and(c.relrowsecurity AND c.relforcerowsecurity)
            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'fitcoach' AND c.relname IN ('sync_state', 'mutation_receipts')
        ''')) is True
    async with db.sessions() as transaction:
        with pytest.raises(DBAPIError):
            async with transaction.begin():
                await transaction.execute(s.profiles.insert().values(user_id=users['a'], client_id='profile',
                    goals='', experience='', equipment=[], training_days=[], session_minutes=45,
                    unit='kg', onboarding_done=False))


async def test_cross_user_reads_updates_and_inserts_fail(api):
    _, db, users = await populated(api)
    async with db.sessions() as transaction, transaction.begin():
        await set_identity(transaction, users['b'])
        for table in s.OWNED_TABLES:
            assert (await transaction.execute(sa.select(table))).all() == []
            result = await transaction.execute(table.update().where(table.c.user_id == users['a']).values(version=99))
            assert result.rowcount == 0
    async with db.sessions() as transaction:
        with pytest.raises(DBAPIError):
            async with transaction.begin():
                await set_identity(transaction, users['b'])
                await transaction.execute(s.profiles.insert().values(user_id=users['a'], client_id='profile',
                    goals='', experience='', equipment=[], training_days=[], session_minutes=45,
                    unit='kg', onboarding_done=False))


async def test_composite_foreign_keys_block_every_cross_user_attachment(api):
    _, db, users = await populated(api)
    async with db.sessions() as transaction, transaction.begin():
        await set_identity(transaction, users['a'])
        source = {}
        for table in s.OWNED_TABLES:
            source[table.name] = dict((await transaction.execute(sa.select(table))).mappings().first())
    # Copy a valid row but attach it to another user's parent/source internal key.
    for table in s.OWNED_TABLES:
        relationships = [fk for fk in table.foreign_key_constraints if any(e.parent.name == 'user_id' for e in fk.elements)]
        if not relationships:
            continue
        row = source[table.name]
        values = {c.name: row[c.name] for c in table.columns
                  if c.name not in ('pk', 'created_at', 'updated_at', 'version', 'deleted_at')}
        values['user_id'] = users['b']
        values['client_id'] = str(uuid4())
        with pytest.raises(IntegrityError):
            async with db.sessions() as transaction, transaction.begin():
                await set_identity(transaction, users['b'])
                await transaction.execute(table.insert().values(**values))


async def test_identity_changes_resurrection_and_catalog_writes_are_denied(api):
    client, db, users = await populated(api)
    for values in [{'user_id': users['b']}, {'client_id': 'recycled'}, {'pk': uuid4()}]:
        with pytest.raises(IntegrityError):
            async with db.sessions() as transaction, transaction.begin():
                await set_identity(transaction, users['a'])
                await transaction.execute(s.training_plans.update().values(**values))
    plan_response = await client.get('/v1/plans/plan', headers=headers())
    assert (await client.delete('/v1/plans/plan', headers=headers(etag=plan_response.headers['etag']))).status_code == 204
    with pytest.raises(IntegrityError):
        async with db.sessions() as transaction, transaction.begin():
            await set_identity(transaction, users['a'])
            await transaction.execute(s.training_plans.update().values(deleted_at=None))
    for operation in [s.exercise_catalog.update().values(name='Changed'), s.exercise_catalog.delete()]:
        with pytest.raises(DBAPIError):
            async with db.sessions() as transaction, transaction.begin():
                await set_identity(transaction, users['a'])
                await transaction.execute(operation)


async def test_connection_pool_never_leaks_identity_after_success_or_failure(api):
    client, db, users = await populated(api)
    for user in ['b', 'a', 'b', 'a', 'b']:
        listing = await client.get('/v1/plans', headers=headers(user))
        assert len(listing.json()['items']) == (1 if user == 'a' else 0)
        assert (await put(client, 'sessions', session('active-' + user, 'active'), user=user)).status_code == 201
        async with db.sessions() as transaction, transaction.begin():
            assert await transaction.scalar(sa.select(sa.func.count()).select_from(s.training_plans)) == 0
            assert await transaction.scalar(sa.text("SELECT NULLIF(current_setting('app.user_id', true), '')")) is None
    assert (await put(client, 'sessions', session('conflict', 'active'))).status_code == 201
    async with db.sessions() as transaction, transaction.begin():
        assert await transaction.scalar(sa.select(sa.func.count()).select_from(s.workout_sessions)) == 0


async def test_runtime_startup_rejects_privileged_credentials(migrated_database):
    database = Database(Settings(database_url=os.environ['FITCOACH_TEST_ADMIN_URL'],
        supabase_url='https://auth.example', supabase_key='key', allow_local_plaintext=True))
    try:
        with pytest.raises(RuntimeError, match='restricted'):
            await database.verify_runtime_role()
    finally:
        await database.close()


async def test_physical_source_purges_are_deferred_and_cannot_delete_history(api):
    client, _, users = await populated(api)
    engine = sa.create_engine(os.environ['FITCOACH_TEST_ADMIN_URL'])
    try:
        for table in [s.training_plans, s.planned_workouts, s.exercises]:
            # Admin bypasses RLS, but never bypasses referential integrity. Parent aggregate
            # cascades cannot remove session snapshots through deferred source references.
            with pytest.raises(IntegrityError):
                with engine.begin() as connection:
                    connection.execute(table.delete().where(table.c.user_id == users['a']))
                    connection.execute(sa.text('SET CONSTRAINTS ALL IMMEDIATE'))
        assert (await client.get('/v1/sessions/session', headers=headers())).json() == session()
    finally:
        engine.dispose()


async def test_database_scalar_checks_reject_invalid_values(api):
    from decimal import Decimal
    _, db, users = await populated(api)
    invalid = [
        (s.profiles, {'training_days': [7]}),
        (s.profiles, {'session_minutes': 9}),
        (s.profiles, {'unit': 'oz'}),
        (s.planned_workout_days, {'day': -1}),
        (s.planned_workouts, {'position': -1}),
        (s.planned_exercises, {'rest_seconds': 1801}),
        (s.planned_sets, {'target_kg': Decimal('NaN')}),
        (s.planned_sets, {'target_kg': Decimal('Infinity')}),
        (s.workout_sets, {'kg': Decimal('-Infinity')}),
        (s.workout_sets, {'effort': Decimal('NaN')}),
        (s.workout_sets, {'done': True, 'reps': None}),
        (s.workout_sessions, {'status': 'completed', 'completed_at': None}),
        (s.workout_sessions, {'status': 'unknown'}),
        (s.workout_sessions, {'timer_remaining': Decimal('Infinity')}),
    ]
    for table, values in invalid:
        with pytest.raises(IntegrityError):
            async with db.sessions() as transaction, transaction.begin():
                await set_identity(transaction, users['a'])
                await transaction.execute(table.update().values(**values))
