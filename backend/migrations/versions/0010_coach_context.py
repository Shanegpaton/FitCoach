"""Recoverable conversation summaries and account-wide Coach memory."""
import os
import re

from alembic import op

revision = '0010'
down_revision = '0009'
branch_labels = None
depends_on = None


def upgrade():
    role = os.getenv('FITCOACH_RUNTIME_ROLE', 'fitcoach_api')
    if not re.fullmatch(r'[a-z_][a-z0-9_]{0,62}', role):
        raise ValueError('Invalid FITCOACH_RUNTIME_ROLE')
    op.execute('''CREATE TABLE fitcoach.coach_memory_settings (
        user_id uuid PRIMARY KEY, automatic boolean NOT NULL DEFAULT true,
        version integer NOT NULL DEFAULT 1, generation integer NOT NULL DEFAULT 1)''')
    op.execute('''CREATE TABLE fitcoach.coach_context (
        user_id uuid NOT NULL, conversation_id uuid PRIMARY KEY,
        summary text NOT NULL DEFAULT '', covered bigint NOT NULL DEFAULT 0,
        memory_cursor bigint NOT NULL DEFAULT 0, version integer NOT NULL DEFAULT 1,
        waiting boolean NOT NULL DEFAULT false,
        FOREIGN KEY (user_id, conversation_id) REFERENCES fitcoach.coach_conversations(user_id, conversation_id) ON DELETE CASCADE,
        CHECK (length(summary) <= 16000 AND covered >= 0 AND memory_cursor >= 0))''')
    op.execute('''CREATE TABLE fitcoach.coach_memories (
        user_id uuid NOT NULL, id uuid PRIMARY KEY, memory_key varchar(120) NOT NULL,
        content varchar(1000) NOT NULL, category varchar(20) NOT NULL,
        edited boolean NOT NULL DEFAULT false, deleted boolean NOT NULL DEFAULT false,
        source_conversation uuid, source_sequence bigint, source_at timestamptz, source_messages jsonb NOT NULL DEFAULT '[]',
        version integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(user_id, memory_key), CHECK (category IN ('health','preference','equipment','constraint')),
        FOREIGN KEY (user_id, source_conversation) REFERENCES fitcoach.coach_conversations(user_id, conversation_id) ON DELETE CASCADE)''')
    op.execute('''CREATE TABLE fitcoach.coach_context_jobs (
        user_id uuid NOT NULL, conversation_id uuid NOT NULL, kind varchar(10) NOT NULL,
        target bigint NOT NULL, attempt uuid, lease_until timestamptz, failures integer NOT NULL DEFAULT 0,
        retry_at timestamptz NOT NULL DEFAULT now(), requested boolean NOT NULL DEFAULT true,
        PRIMARY KEY (conversation_id, kind), CHECK(kind IN ('summary','memory')),
        FOREIGN KEY (user_id, conversation_id) REFERENCES fitcoach.coach_conversations(user_id, conversation_id) ON DELETE CASCADE)''')
    op.execute('CREATE INDEX coach_context_jobs_ready ON fitcoach.coach_context_jobs(user_id, retry_at) WHERE requested')
    for table in ('coach_memory_settings', 'coach_context', 'coach_memories', 'coach_context_jobs'):
        condition = "user_id = NULLIF(current_setting('app.user_id', true), '')::uuid"
        op.execute(f'ALTER TABLE fitcoach.{table} ENABLE ROW LEVEL SECURITY')
        op.execute(f'ALTER TABLE fitcoach.{table} FORCE ROW LEVEL SECURITY')
        op.execute(f'CREATE POLICY owner_access ON fitcoach.{table} USING ({condition}) WITH CHECK ({condition})')
        op.execute(f'GRANT SELECT, INSERT, UPDATE, DELETE ON fitcoach.{table} TO "{role}"')


def downgrade():
    for table in ('coach_context_jobs', 'coach_memories', 'coach_context', 'coach_memory_settings'):
        op.drop_table(table, schema='fitcoach')
