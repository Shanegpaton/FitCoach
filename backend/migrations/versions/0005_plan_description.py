"""Add the plan description field supported by structured Coach proposals."""
from alembic import op
import sqlalchemy as sa

revision = '0005'
down_revision = '0004'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('training_plans', sa.Column('description', sa.Text(), nullable=False, server_default=''), schema='fitcoach')
    op.create_check_constraint('description', 'training_plans', 'length(description) <= 2000', schema='fitcoach')


def downgrade():
    op.drop_constraint('ck_training_plans_description', 'training_plans', schema='fitcoach', type_='check')
    op.drop_column('training_plans', 'description', schema='fitcoach')
