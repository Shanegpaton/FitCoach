"""Account-scoped persistent Coach conversations and turns."""
import os
import re

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID, JSONB

revision = '0006'
down_revision = '0005'
branch_labels = None
depends_on = None


def upgrade():
    role = os.getenv('FITCOACH_RUNTIME_ROLE', 'fitcoach_api')
    if not re.fullmatch(r'[a-z_][a-z0-9_]{0,62}', role):
        raise ValueError('Invalid FITCOACH_RUNTIME_ROLE')
    op.create_table('coach_conversations',
        sa.Column('user_id', UUID(as_uuid=True), nullable=False),
        sa.Column('conversation_id', UUID(as_uuid=True), primary_key=True),
        sa.Column('thread_id', sa.String(36), nullable=False, unique=True),
        sa.Column('title', sa.String(160), nullable=False, server_default='New conversation'),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint('user_id', 'conversation_id', name='uq_coach_conversations_owner'),
        schema='fitcoach')
    op.create_index('ix_coach_conversations_owner_updated', 'coach_conversations', ['user_id', sa.text('updated_at DESC')], schema='fitcoach')
    op.create_table('coach_messages',
        sa.Column('message_id', UUID(as_uuid=True), primary_key=True),
        sa.Column('user_id', UUID(as_uuid=True), nullable=False),
        sa.Column('conversation_id', UUID(as_uuid=True), nullable=False),
        sa.Column('sequence', sa.BigInteger(), nullable=False),
        sa.Column('role', sa.String(16), nullable=False),
        sa.Column('content', sa.Text(), nullable=False),
        sa.Column('metadata', JSONB(), nullable=False, server_default='{}'),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.ForeignKeyConstraint(['user_id', 'conversation_id'], ['fitcoach.coach_conversations.user_id', 'fitcoach.coach_conversations.conversation_id'], ondelete='CASCADE'),
        sa.UniqueConstraint('conversation_id', 'sequence', name='uq_coach_messages_sequence'),
        sa.CheckConstraint("role IN ('user', 'assistant')", name='coach_message_role'),
        sa.CheckConstraint('length(content) BETWEEN 1 AND 10000', name='coach_message_content'),
        schema='fitcoach')
    op.create_index('ix_coach_messages_conversation_order', 'coach_messages', ['conversation_id', 'sequence'], schema='fitcoach')
    op.create_table('coach_turns',
        sa.Column('user_id', UUID(as_uuid=True), nullable=False),
        sa.Column('conversation_id', UUID(as_uuid=True), nullable=False),
        sa.Column('request_id', UUID(as_uuid=True), nullable=False),
        sa.Column('user_message_id', UUID(as_uuid=True), nullable=False),
        sa.Column('assistant_message_id', UUID(as_uuid=True), nullable=True),
        sa.Column('status', sa.String(16), nullable=False, server_default='started'),
        sa.Column('assistant_content', sa.Text(), nullable=True),
        sa.Column('assistant_metadata', JSONB(), nullable=False, server_default='{}'),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column('completed_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['user_id', 'conversation_id'], ['fitcoach.coach_conversations.user_id', 'fitcoach.coach_conversations.conversation_id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('conversation_id', 'request_id'),
        sa.CheckConstraint("status IN ('started', 'completed', 'failed')", name='coach_turn_status'),
        schema='fitcoach')
    for table in ('coach_conversations', 'coach_messages', 'coach_turns'):
        condition = "user_id = NULLIF(current_setting('app.user_id', true), '')::uuid"
        op.execute(f'ALTER TABLE fitcoach.{table} ENABLE ROW LEVEL SECURITY')
        op.execute(f'ALTER TABLE fitcoach.{table} FORCE ROW LEVEL SECURITY')
        op.execute(f'CREATE POLICY owner_access ON fitcoach.{table} USING ({condition}) WITH CHECK ({condition})')
        op.execute(f'GRANT SELECT, INSERT, UPDATE, DELETE ON fitcoach.{table} TO "{role}"')


def downgrade():
    for table in ('coach_turns', 'coach_messages', 'coach_conversations'):
        op.execute(f'DROP POLICY owner_access ON fitcoach.{table}')
        op.drop_table(table, schema='fitcoach')
