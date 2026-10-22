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
        await saver.setup()
        # These tables are in public because the upstream saver owns its schema.
        # Restrict table access to the backend runtime role; browser clients have
        # no database credentials. Application APIs resolve thread ownership first.
        async with saver.conn.cursor() as cursor:
            await cursor.execute('''SELECT tablename FROM pg_tables WHERE schemaname='public'
                AND tablename IN ('checkpoints','checkpoint_writes','checkpoint_blobs','checkpoint_migrations')''')
            tables = [row['tablename'] for row in await cursor.fetchall()]
            for table in tables:
                await cursor.execute(f'REVOKE ALL ON TABLE public.{table} FROM PUBLIC')
                await cursor.execute(f'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.{table} TO "{runtime_role}"')


if __name__ == '__main__':
    asyncio.run(main())
