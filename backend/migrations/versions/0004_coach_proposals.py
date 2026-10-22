"""Persist account scoped Coach plan proposals for review across requests."""
import os
import re

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

revision = '0004'
down_revision = '0003'
branch_labels = None
depends_on = None


def upgrade():
    role = os.getenv('FITCOACH_RUNTIME_ROLE', 'fitcoach_api')
    if not re.fullmatch(r'[a-z_][a-z0-9_]{0,62}', role):
        raise ValueError('Invalid FITCOACH_RUNTIME_ROLE')
    op.create_table('coach_proposals',
        sa.Column('user_id', UUID(as_uuid=True), nullable=False),
        sa.Column('proposal_id', UUID(as_uuid=True), primary_key=True),
        sa.Column('proposal_type', sa.Text(), nullable=False),
        sa.Column('target_plan_id', sa.Text(), nullable=True),
        sa.Column('source_etag', sa.Text(), nullable=True),
        sa.Column('proposal_json', sa.Text(), nullable=False),
        sa.Column('summary', sa.Text(), nullable=False),
        sa.Column('status', sa.Text(), nullable=False, server_default='pending'),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("proposal_type IN ('create', 'modify')", name='coach_proposal_type'),
        sa.CheckConstraint("status IN ('pending', 'approved', 'rejected', 'expired', 'invalidated')", name='coach_proposal_status'),
        schema='fitcoach')
    condition = "user_id = NULLIF(current_setting('app.user_id', true), '')::uuid"
    op.execute('ALTER TABLE fitcoach.coach_proposals ENABLE ROW LEVEL SECURITY')
    op.execute('ALTER TABLE fitcoach.coach_proposals FORCE ROW LEVEL SECURITY')
    op.execute(f'CREATE POLICY owner_access ON fitcoach.coach_proposals USING ({condition}) WITH CHECK ({condition})')
    op.execute(f'GRANT SELECT, INSERT, UPDATE ON fitcoach.coach_proposals TO "{role}"')


def downgrade():
    op.execute('DROP POLICY owner_access ON fitcoach.coach_proposals')
    op.drop_table('coach_proposals', schema='fitcoach')
