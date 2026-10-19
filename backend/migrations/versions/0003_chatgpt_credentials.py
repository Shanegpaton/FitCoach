"""Store encrypted ChatGPT credentials per verified FitCoach account."""
import os
import re

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

revision = '0003'
down_revision = '0002'
branch_labels = None
depends_on = None


def upgrade():
    role = os.getenv('FITCOACH_RUNTIME_ROLE', 'fitcoach_api')
    if not re.fullmatch(r'[a-z_][a-z0-9_]{0,62}', role):
        raise ValueError('Invalid FITCOACH_RUNTIME_ROLE')
    op.create_table('chatgpt_credentials',
        sa.Column('user_id', UUID(as_uuid=True), primary_key=True),
        sa.Column('ciphertext', sa.LargeBinary(), nullable=False),
        sa.Column('email', sa.Text(), nullable=True),
        sa.Column('name', sa.Text(), nullable=True),
        sa.Column('plan_usage_granted', sa.Boolean(), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        schema='fitcoach')
    condition = "user_id = NULLIF(current_setting('app.user_id', true), '')::uuid"
    op.execute('ALTER TABLE fitcoach.chatgpt_credentials ENABLE ROW LEVEL SECURITY')
    op.execute('ALTER TABLE fitcoach.chatgpt_credentials FORCE ROW LEVEL SECURITY')
    op.execute(f'CREATE POLICY owner_access ON fitcoach.chatgpt_credentials USING ({condition}) WITH CHECK ({condition})')
    op.execute(f'GRANT SELECT, INSERT, UPDATE, DELETE ON fitcoach.chatgpt_credentials TO "{role}"')


def downgrade():
    op.execute('DROP POLICY owner_access ON fitcoach.chatgpt_credentials')
    op.drop_table('chatgpt_credentials', schema='fitcoach')
