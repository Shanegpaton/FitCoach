"""Private relational training storage, ownership policies, and immutable catalog seed."""
import os
import re

from alembic import op
import sqlalchemy as sa

from backend.migrations.schema_v1 import metadata, OWNED_TABLES, exercise_catalog

revision = '0001'
down_revision = None
branch_labels = None
depends_on = None

CATALOG = [
    ('squat', 'Barbell squat', 'Quads', 'Barbell'),
    ('bench', 'Bench press', 'Chest', 'Barbell'),
    ('deadlift', 'Romanian deadlift', 'Hamstrings', 'Barbell'),
    ('row', 'Dumbbell row', 'Back', 'Dumbbell'),
    ('press', 'Overhead press', 'Shoulders', 'Dumbbell'),
    ('pulldown', 'Lat pulldown', 'Back', 'Cable'),
    ('legpress', 'Leg press', 'Quads', 'Machine'),
    ('curl', 'Biceps curl', 'Arms', 'Dumbbell'),
    ('triceps', 'Triceps pushdown', 'Arms', 'Cable'),
    ('lateral', 'Lateral raise', 'Shoulders', 'Dumbbell'),
    ('pullup', 'Pull-up', 'Back', 'Bodyweight'),
    ('pushup', 'Push-up', 'Chest', 'Bodyweight'),
]


def upgrade():
    role = os.getenv('FITCOACH_RUNTIME_ROLE', 'fitcoach_api')
    if not re.fullmatch(r'[a-z_][a-z0-9_]{0,62}', role):
        raise ValueError('Invalid FITCOACH_RUNTIME_ROLE')
    op.execute('CREATE SCHEMA fitcoach')
    op.execute('REVOKE ALL ON SCHEMA fitcoach FROM PUBLIC')
    metadata.create_all(op.get_bind())
    op.execute('''
        CREATE FUNCTION fitcoach.maintain_metadata() RETURNS trigger
        LANGUAGE plpgsql SET search_path = pg_catalog AS $$
        BEGIN
            IF TG_OP = 'INSERT' THEN
                NEW.created_at := clock_timestamp();
                NEW.updated_at := NEW.created_at;
                NEW.version := 1;
            ELSE
                IF NEW.pk <> OLD.pk OR NEW.user_id <> OLD.user_id OR NEW.client_id <> OLD.client_id THEN
                    RAISE EXCEPTION 'Record identities are immutable' USING ERRCODE = '23514';
                END IF;
                IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL THEN
                    RAISE EXCEPTION 'Tombstones cannot be reused' USING ERRCODE = '23514';
                END IF;
                NEW.created_at := OLD.created_at;
                NEW.updated_at := clock_timestamp();
                NEW.version := OLD.version + 1;
            END IF;
            RETURN NEW;
        END $$
    ''')
    for table in OWNED_TABLES:
        name = table.name
        op.execute(f'ALTER TABLE fitcoach.{name} ENABLE ROW LEVEL SECURITY')
        op.execute(f'ALTER TABLE fitcoach.{name} FORCE ROW LEVEL SECURITY')
        condition = "user_id = NULLIF(current_setting('app.user_id', true), '')::uuid"
        op.execute(f'CREATE POLICY owner_access ON fitcoach.{name} USING ({condition}) WITH CHECK ({condition})')
        op.execute(f'CREATE TRIGGER metadata BEFORE INSERT OR UPDATE ON fitcoach.{name} '
                   'FOR EACH ROW EXECUTE FUNCTION fitcoach.maintain_metadata()')
        op.execute(f'GRANT SELECT, INSERT, UPDATE ON fitcoach.{name} TO "{role}"')
    op.execute(f'GRANT USAGE ON SCHEMA fitcoach TO "{role}"')
    op.execute(f'GRANT SELECT ON fitcoach.exercise_catalog TO "{role}"')
    op.bulk_insert(exercise_catalog, [dict(client_id=f'ex-{id_}', name=name, muscle=muscle,
        equipment=equipment, load_mode='bodyweight' if equipment == 'Bodyweight' else 'external', custom=False)
        for id_, name, muscle, equipment in CATALOG])


def downgrade():
    metadata.drop_all(op.get_bind())
    op.execute('DROP FUNCTION fitcoach.maintain_metadata()')
    op.execute('DROP SCHEMA fitcoach')
