"""Reviewable completed-workout edits, retaining before and after snapshots."""
from alembic import op
import sqlalchemy as sa

revision = '0008'
down_revision = '0007'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('coach_proposals', sa.Column('target_session_id', sa.Text()), schema='fitcoach')
    op.drop_constraint('coach_proposal_type', 'coach_proposals', schema='fitcoach', type_='check')
    op.create_check_constraint('coach_proposal_type', 'coach_proposals',
        "proposal_type IN ('create', 'modify', 'session_modify')", schema='fitcoach')


def downgrade():
    # Keep historical workout proposals and their recovery snapshots intact.
    op.execute("""DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM fitcoach.coach_proposals WHERE proposal_type='session_modify') THEN
            RAISE EXCEPTION 'Workout proposals exist; archive them before downgrading';
        END IF;
    END $$""")
    op.drop_constraint('coach_proposal_type', 'coach_proposals', schema='fitcoach', type_='check')
    op.create_check_constraint('coach_proposal_type', 'coach_proposals',
        "proposal_type IN ('create', 'modify')", schema='fitcoach')
    op.drop_column('coach_proposals', 'target_session_id', schema='fitcoach')
