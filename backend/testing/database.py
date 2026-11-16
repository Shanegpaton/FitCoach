"""Explicitly destructive helpers for acknowledged disposable test databases."""
import psycopg
from psycopg import sql
from sqlalchemy.engine import make_url


def clear_training_data(admin_url):
    """Empty app records before testing downgrade guards; leave schema to Alembic."""
    dsn = make_url(admin_url).set(drivername='postgresql').render_as_string(hide_password=False)
    with psycopg.connect(dsn) as connection:
        tables = connection.execute("SELECT tablename FROM pg_tables WHERE schemaname='fitcoach'").fetchall()
        if tables:
            connection.execute(sql.SQL('TRUNCATE {} RESTART IDENTITY CASCADE').format(
                sql.SQL(', ').join(sql.Identifier('fitcoach', row[0]) for row in tables)))
