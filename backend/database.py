from uuid import UUID

import sqlalchemy as sa
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from backend.config import Settings


class Database:
    def __init__(self, settings: Settings):
        connect_args = {'connect_timeout': 10}
        if make_url(settings.database_url).port == 6543:
            # Supabase's transaction pooler cannot use server-side prepared statements.
            connect_args['prepare_threshold'] = None
        self.engine = create_async_engine(settings.database_url,
            pool_size=settings.pool_size, max_overflow=0, pool_timeout=settings.pool_timeout,
            pool_pre_ping=True, pool_recycle=300, connect_args=connect_args)
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)

    async def verify_runtime_role(self):
        async with self.engine.connect() as connection:
            unsafe = await connection.scalar(sa.text('''
                SELECT r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb
                    OR EXISTS (
                        SELECT 1 FROM pg_roles elevated
                        WHERE (elevated.rolsuper OR elevated.rolbypassrls)
                          AND pg_has_role(current_user, elevated.oid, 'MEMBER')
                    ) OR EXISTS (
                        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                        WHERE n.nspname = 'fitcoach'
                          AND pg_has_role(current_user, c.relowner, 'MEMBER')
                    ) OR has_schema_privilege(current_user, 'fitcoach', 'CREATE')
                FROM pg_roles r WHERE r.rolname = current_user
            '''))
            if unsafe is not False:
                raise RuntimeError('Runtime PostgreSQL role must be restricted, non-owner, and unable to bypass RLS')
            insecure = await connection.scalar(sa.text('''
                SELECT EXISTS (
                    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE n.nspname = 'fitcoach' AND c.relkind = 'r'
                      AND c.relname <> 'exercise_catalog'
                      AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity)
                ) OR has_table_privilege(current_user, 'fitcoach.exercise_catalog', 'INSERT,UPDATE,DELETE,TRUNCATE')
            '''))
            if insecure:
                raise RuntimeError('Owned tables must force RLS and the exercise catalog must be read-only')
            # Fail startup for absent migrations or missing runtime read grants.
            await connection.execute(sa.text('SELECT client_id FROM fitcoach.exercise_catalog LIMIT 1'))

    async def close(self):
        await self.engine.dispose()


async def set_identity(session: AsyncSession, user_id: UUID):
    await session.execute(sa.text("SELECT set_config('app.user_id', :user_id, true)"), {'user_id': str(user_id)})


async def lock_user_mutations(session: AsyncSession, user_id: UUID):
    # Serializes an account's mutations even before it has an aggregate root.
    # This avoids activation/child/source-deletion races; RLS still enforces ownership.
    await session.execute(sa.text('SELECT pg_advisory_xact_lock(hashtextextended(:user_id, 0))'),
                          {'user_id': str(user_id)})
