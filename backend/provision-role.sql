-- Run as a privileged database administrator with psql, before Alembic.
-- Password is supplied with psql -v runtime_password=... from your secret store.
-- This creates only a new role; it does not modify Supabase's managed roles.
CREATE ROLE fitcoach_api LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS
    PASSWORD :'runtime_password';
-- Tables, schema usage and catalog read grants are supplied by Alembic.
