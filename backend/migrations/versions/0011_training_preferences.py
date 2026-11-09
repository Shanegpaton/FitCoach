"""General training preferences and optional per-workout duration targets."""
from alembic import op
import sqlalchemy as sa

revision = '0011'
down_revision = '0010'
branch_labels = None
depends_on = None

PROFILE_FIELDS = {
    'training_background': (sa.Text, 'length(training_background) <= 2000'),
    'days_per_week': (sa.Integer, 'days_per_week BETWEEN 1 AND 7'),
    'exercise_preferences': (sa.Text, 'length(exercise_preferences) <= 2000'),
    'limitations': (sa.Text, 'length(limitations) <= 2000'),
}


def upgrade():
    # Preserve legacy session_minutes; it cannot describe individual workouts.
    for name, (kind, constraint) in PROFILE_FIELDS.items():
        op.add_column('profiles', sa.Column(name, kind(), nullable=True), schema='fitcoach')
        op.create_check_constraint(name, 'profiles', constraint, schema='fitcoach')
    op.add_column('planned_workouts', sa.Column('duration_minutes', sa.Integer(), nullable=True), schema='fitcoach')
    op.create_check_constraint('duration_minutes', 'planned_workouts',
                               'duration_minutes BETWEEN 10 AND 180', schema='fitcoach')


def downgrade():
    op.drop_constraint(op.f('ck_planned_workouts_duration_minutes'), 'planned_workouts', schema='fitcoach', type_='check')
    op.drop_column('planned_workouts', 'duration_minutes', schema='fitcoach')
    for name in reversed(PROFILE_FIELDS):
        op.drop_constraint(op.f(f'ck_profiles_{name}'), 'profiles', schema='fitcoach', type_='check')
        op.drop_column('profiles', name, schema='fitcoach')
