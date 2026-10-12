import os

from alembic import context
from sqlalchemy import create_engine, pool

from backend.config import validate_url
from backend.schema import metadata

url = validate_url(os.environ['FITCOACH_MIGRATION_DATABASE_URL'],
                   os.getenv('FITCOACH_ALLOW_LOCAL_PLAINTEXT', 'false').lower() == 'true')


def configure(connection=None):
    context.configure(connection=connection, url=url if connection is None else None,
        target_metadata=metadata, include_schemas=True, version_table_schema='public',
        include_name=lambda name, type_, parent: name == 'fitcoach' if type_ == 'schema' else True,
        literal_binds=connection is None)
    with context.begin_transaction():
        context.run_migrations()


if context.is_offline_mode():
    configure()
else:
    engine = create_engine(url, poolclass=pool.NullPool)
    with engine.connect() as connection:
        configure(connection)
    engine.dispose()
