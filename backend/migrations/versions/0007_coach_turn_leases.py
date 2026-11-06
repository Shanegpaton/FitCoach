"""Recover abandoned Coach attempts and fence stale workers."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

revision = '0007'
down_revision = '0006'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('coach_turns', sa.Column('attempt_id', UUID(as_uuid=True)), schema='fitcoach')
    op.add_column('coach_turns', sa.Column('lease_expires_at', sa.DateTime(timezone=True)), schema='fitcoach')
    op.add_column('coach_turns', sa.Column('attempt_started_at', sa.DateTime(timezone=True)), schema='fitcoach')
    # Existing started requests have no provable owner after deployment.
    op.execute("UPDATE fitcoach.coach_turns SET status='failed' WHERE status='started'")
    op.create_index('ix_coach_turns_active', 'coach_turns', ['user_id', 'conversation_id'],
                    schema='fitcoach', unique=True, postgresql_where=sa.text("status='started'"))


def downgrade():
    op.drop_index('ix_coach_turns_active', table_name='coach_turns', schema='fitcoach')
    for name in ('attempt_started_at', 'lease_expires_at', 'attempt_id'):
        op.drop_column('coach_turns', name, schema='fitcoach')
