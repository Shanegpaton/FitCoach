"""One-time deployment setup for LangGraph checkpoint tables.

Run after Alembic migrations using the migration database URL. Checkpoint data is
only accessed by the authenticated API; it is never exposed to browser clients.
"""
import asyncio
import os
import re

from sqlalchemy.engine import make_url


async def main():
    os.environ.setdefault('LANGGRAPH_STRICT_MSGPACK', 'true')
    from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver

    migration_url = make_url(os.environ['FITCOACH_MIGRATION_DATABASE_URL'])
    runtime_role = os.getenv('FITCOACH_RUNTIME_ROLE', 'fitcoach_api')
    if not re.fullmatch(r'[a-z_][a-z0-9_]{0,62}', runtime_role):
        raise ValueError('Invalid FITCOACH_RUNTIME_ROLE')
    # psycopg accepts PostgreSQL URLs, while SQLAlchemy's URL contains +psycopg.
    dsn = migration_url.set(drivername='postgresql').render_as_string(hide_password=False)
    async with AsyncPostgresSaver.from_conn_string(dsn) as saver:
        # Upstream saver DDL is unqualified. Keep it in public even when the
        # migration role has a custom PostgreSQL search_path.
        await saver.conn.execute('SET search_path TO public')
        await saver.setup()
        # LangGraph's saver owns its table definitions, but they live in an
        # exposed Supabase schema. Remove Supabase API-role grants and enable
        # RLS so only the restricted backend role can access checkpoint rows.
        async with saver.conn.cursor() as cursor:
            await cursor.execute('''SELECT tablename FROM pg_tables WHERE schemaname='public'
                AND tablename IN ('checkpoints','checkpoint_writes','checkpoint_blobs',
                                 'checkpoint_migrations','alembic_version')''')
            tables = [row['tablename'] for row in await cursor.fetchall()]
            for table in tables:
                await cursor.execute(f'REVOKE ALL ON TABLE public.{table} FROM PUBLIC')
                for api_role in ('anon', 'authenticated', 'service_role'):
                    await cursor.execute('SELECT 1 FROM pg_roles WHERE rolname = %s', (api_role,))
                    if await cursor.fetchone():
                        await cursor.execute(f'REVOKE ALL ON TABLE public.{table} FROM "{api_role}"')
                await cursor.execute(f'ALTER TABLE public.{table} ENABLE ROW LEVEL SECURITY')
                if table == 'alembic_version':
                    # Migration metadata is only used by the privileged
                    # migration connection, never by the API runtime.
                    await cursor.execute(f'REVOKE ALL ON TABLE public.{table} FROM "{runtime_role}"')
                    continue
                await cursor.execute(f'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.{table} TO "{runtime_role}"')
                await cursor.execute(f'DROP POLICY IF EXISTS fitcoach_api_only ON public.{table}')
                await cursor.execute(f'''CREATE POLICY fitcoach_api_only ON public.{table}
                    FOR ALL TO "{runtime_role}" USING (true) WITH CHECK (true)''')


if __name__ == '__main__':
    asyncio.run(main())
