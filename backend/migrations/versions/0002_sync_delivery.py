"""Add durable sync cursors, mutation receipts, and lossless active sessions."""
import os
import re

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

from backend.schema import SYNC_ROOTS

revision = '0002'
down_revision = '0001'
branch_labels = None
depends_on = None


def upgrade():
    role = os.getenv('FITCOACH_RUNTIME_ROLE', 'fitcoach_api')
    if not re.fullmatch(r'[a-z_][a-z0-9_]{0,62}', role):
        raise ValueError('Invalid FITCOACH_RUNTIME_ROLE')
    for root in SYNC_ROOTS:
        op.add_column(root.name, sa.Column('sync_sequence', sa.BigInteger(), nullable=False, server_default='0'), schema='fitcoach')

    op.create_table('sync_state',
        sa.Column('user_id', UUID(as_uuid=True), primary_key=True),
        sa.Column('sequence', sa.BigInteger(), nullable=False, server_default='0'),
        schema='fitcoach')
    op.create_table('mutation_receipts',
        sa.Column('user_id', UUID(as_uuid=True), primary_key=True),
        sa.Column('mutation_id', UUID(as_uuid=True), primary_key=True),
        sa.Column('request_hash', sa.String(64), nullable=False),
        sa.Column('status_code', sa.Integer(), nullable=False),
        sa.Column('response_body', sa.Text(), nullable=False),
        sa.Column('response_etag', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        schema='fitcoach')
    op.create_index('ix_mutation_receipts_created', 'mutation_receipts', ['created_at'], schema='fitcoach')

    # Existing account data is visible on its first sync, with a unique ordered cursor.
    union = ' UNION ALL '.join(
        f"SELECT user_id, '{root.name}' AS resource, pk FROM fitcoach.{root.name}"
        for root in SYNC_ROOTS)
    for root in SYNC_ROOTS:
        op.execute(f'''WITH numbered AS (
            SELECT user_id, resource, pk,
                   row_number() OVER (PARTITION BY user_id ORDER BY resource, pk) AS seq
            FROM ({union}) AS roots
        ) UPDATE fitcoach.{root.name} AS target
           SET sync_sequence = numbered.seq
          FROM numbered
         WHERE numbered.resource = '{root.name}'
           AND target.user_id = numbered.user_id AND target.pk = numbered.pk''')
    op.execute(f'''INSERT INTO fitcoach.sync_state(user_id, sequence)
        SELECT user_id, count(*) FROM ({union}) AS roots GROUP BY user_id''')

    op.drop_index('uq_workout_sessions_active', table_name='workout_sessions', schema='fitcoach')

    condition = "user_id = NULLIF(current_setting('app.user_id', true), '')::uuid"
    for table in ('sync_state', 'mutation_receipts'):
        op.execute(f'ALTER TABLE fitcoach.{table} ENABLE ROW LEVEL SECURITY')
        op.execute(f'ALTER TABLE fitcoach.{table} FORCE ROW LEVEL SECURITY')
        op.execute(f'CREATE POLICY owner_access ON fitcoach.{table} USING ({condition}) WITH CHECK ({condition})')
    op.execute(f'GRANT SELECT, INSERT, UPDATE ON fitcoach.sync_state TO "{role}"')
    op.execute(f'GRANT SELECT, INSERT ON fitcoach.mutation_receipts TO "{role}"')


def downgrade():
    op.execute('DROP POLICY owner_access ON fitcoach.mutation_receipts')
    op.execute('DROP POLICY owner_access ON fitcoach.sync_state')
    op.drop_index('ix_mutation_receipts_created', table_name='mutation_receipts', schema='fitcoach')
    op.drop_table('mutation_receipts', schema='fitcoach')
    op.drop_table('sync_state', schema='fitcoach')
    op.create_index('uq_workout_sessions_active', 'workout_sessions', ['user_id'], unique=True,
        schema='fitcoach', postgresql_where=sa.text("status = 'active' AND deleted_at IS NULL"))
    for root in reversed(SYNC_ROOTS):
        op.drop_column(root.name, 'sync_sequence', schema='fitcoach')
