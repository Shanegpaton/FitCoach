"""Explicit account-scoped Coach model preferences."""
import os
import re

from alembic import op

revision = '0012'
down_revision = '0011'
branch_labels = None
depends_on = None


def upgrade():
    role = os.getenv('FITCOACH_RUNTIME_ROLE', 'fitcoach_api')
    if not re.fullmatch(r'[a-z_][a-z0-9_]{0,62}', role):
        raise ValueError('Invalid FITCOACH_RUNTIME_ROLE')
    op.execute('''CREATE TABLE fitcoach.coach_model_settings (
        user_id uuid PRIMARY KEY, preferred_model varchar(200),
        version integer NOT NULL DEFAULT 1,
        CHECK (preferred_model IS NULL OR length(trim(preferred_model)) > 0))''')
    condition = "user_id = NULLIF(current_setting('app.user_id', true), '')::uuid"
    op.execute('ALTER TABLE fitcoach.coach_model_settings ENABLE ROW LEVEL SECURITY')
    op.execute('ALTER TABLE fitcoach.coach_model_settings FORCE ROW LEVEL SECURITY')
    op.execute(f'CREATE POLICY owner_access ON fitcoach.coach_model_settings USING ({condition}) WITH CHECK ({condition})')
    op.execute(f'GRANT SELECT, INSERT, UPDATE, DELETE ON fitcoach.coach_model_settings TO "{role}"')


def downgrade():
    op.drop_table('coach_model_settings', schema='fitcoach')
