"""Allow reviewable creation of active workout sessions."""
from alembic import op

revision = '0009'
down_revision = '0008'
branch_labels = None
depends_on = None


def upgrade():
    op.drop_constraint('coach_proposal_type', 'coach_proposals', schema='fitcoach', type_='check')
    op.create_check_constraint('coach_proposal_type', 'coach_proposals',
        "proposal_type IN ('create', 'modify', 'session_modify', 'session_create')", schema='fitcoach')


def downgrade():
    op.execute("""DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM fitcoach.coach_proposals WHERE proposal_type='session_create') THEN
            RAISE EXCEPTION 'Workout start proposals exist; archive them before downgrading';
        END IF;
    END $$""")
    op.drop_constraint('coach_proposal_type', 'coach_proposals', schema='fitcoach', type_='check')
    op.create_check_constraint('coach_proposal_type', 'coach_proposals',
        "proposal_type IN ('create', 'modify', 'session_modify')", schema='fitcoach')
