"""Relational SQLAlchemy 2 metadata. No document/JSON columns."""
from uuid import uuid4

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import ARRAY, UUID

metadata = sa.MetaData(schema='fitcoach', naming_convention={
    'ix': 'ix_%(table_name)s_%(column_0_name)s',
    'uq': 'uq_%(table_name)s_%(column_0_N_name)s',
    'ck': 'ck_%(table_name)s_%(constraint_name)s',
    'fk': 'fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s',
    'pk': 'pk_%(table_name)s',
})


def col(name, type_, nullable=False):
    return sa.Column(name, type_, nullable=nullable)


def check(name, expression):
    return sa.CheckConstraint(expression, name=name)


def link(column, parent, cascade=False, extra=()):
    return sa.ForeignKeyConstraint(
        ['user_id', column, *[x[0] for x in extra]],
        [f'fitcoach.{parent}.user_id', f'fitcoach.{parent}.pk', *[f'fitcoach.{parent}.{x[1]}' for x in extra]],
        ondelete='CASCADE' if cascade else 'NO ACTION',
        deferrable=not cascade, initially='DEFERRED' if not cascade else None,
    )


def owned(name, *columns, parent=None, constraints=()):
    t = sa.Table(name, metadata,
        sa.Column('pk', UUID(as_uuid=True), primary_key=True, default=uuid4, server_default=sa.text('gen_random_uuid()')),
        col('user_id', UUID(as_uuid=True)), col('client_id', sa.Text),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column('version', sa.BigInteger, nullable=False, server_default='1'),
        col('deleted_at', sa.DateTime(timezone=True), True),
        *columns,
        sa.UniqueConstraint('user_id', 'pk'),
        sa.UniqueConstraint('user_id', *([parent] if parent else []), 'client_id'),
        check('client_id', "length(client_id) > 0"), check('version', 'version > 0'),
        *constraints,
    )
    sa.Index(f'ix_{name}_user_updated', t.c.user_id, t.c.updated_at)
    if parent:
        sa.Index(f'ix_{name}_parent', t.c.user_id, t.c[parent])
    if 'position' in t.c:
        sa.Index(f'uq_{name}_live_position', t.c.user_id, t.c[parent], t.c.position,
                 unique=True, postgresql_where=t.c.deleted_at.is_(None))
    return t


def ordered():
    return col('position', sa.Integer)


def position_check():
    return check('position', 'position >= 0')


def exercise_fields():
    return [col('name', sa.Text), col('muscle', sa.Text), col('equipment', sa.Text),
            col('load_mode', sa.Text), col('custom', sa.Boolean)]


def exercise_checks():
    return [check('name', 'length(btrim(name)) BETWEEN 1 AND 100'),
            check('muscle', 'length(muscle) <= 100'), check('equipment', 'length(equipment) <= 100'),
            check('load_mode', "load_mode IN ('external', 'bodyweight')")]


profiles = owned('profiles', col('goals', sa.Text), col('experience', sa.Text),
    col('equipment', ARRAY(sa.Text)), col('training_days', ARRAY(sa.Integer)),
    col('session_minutes', sa.Integer), col('unit', sa.Text), col('onboarding_done', sa.Boolean),
    constraints=[sa.UniqueConstraint('user_id'), check('profile_id', "client_id = 'profile'"),
        check('goals', 'length(goals) <= 2000'), check('session_minutes', 'session_minutes BETWEEN 10 AND 180'),
        check('unit', "unit IN ('lb', 'kg')"),
        check('training_days', "training_days <@ ARRAY[0,1,2,3,4,5,6] AND array_position(training_days, NULL) IS NULL"),
        check('equipment', 'array_position(equipment, NULL) IS NULL')])
exercise_catalog = sa.Table('exercise_catalog', metadata, col('client_id', sa.Text),
    *exercise_fields(), sa.PrimaryKeyConstraint('client_id'), *exercise_checks())
exercises = owned('exercises', col('catalog_id', sa.Text, True), *exercise_fields(), constraints=[
    sa.ForeignKeyConstraint(['catalog_id'], ['fitcoach.exercise_catalog.client_id']), *exercise_checks()])
training_plans = owned('training_plans', col('name', sa.Text), col('description', sa.Text), col('schedule', sa.Text),
    col('cursor', sa.Integer), col('revision', sa.Integer), col('active', sa.Boolean), constraints=[
        check('name', 'length(btrim(name)) BETWEEN 1 AND 100'), check('description', 'length(description) <= 2000'), check('schedule', "schedule IN ('week', 'rotation')"),
        check('cursor', 'cursor >= 0'), check('revision', 'revision >= 0')])
sa.Index('uq_training_plans_active', training_plans.c.user_id, unique=True,
         postgresql_where=sa.and_(training_plans.c.active, training_plans.c.deleted_at.is_(None)))
planned_workouts = owned('planned_workouts', col('plan_pk', UUID(as_uuid=True)), ordered(), col('name', sa.Text),
    parent='plan_pk', constraints=[link('plan_pk', 'training_plans', True), position_check(),
        check('name', 'length(btrim(name)) BETWEEN 1 AND 100'), sa.UniqueConstraint('user_id', 'pk', 'plan_pk')])
planned_workout_days = owned('planned_workout_days', col('workout_pk', UUID(as_uuid=True)), ordered(),
    col('day', sa.Integer), parent='workout_pk', constraints=[link('workout_pk', 'planned_workouts', True),
        position_check(), check('day', 'day BETWEEN 0 AND 6')])
planned_exercises = owned('planned_exercises', col('workout_pk', UUID(as_uuid=True)), ordered(),
    col('exercise_pk', UUID(as_uuid=True)), col('rest_seconds', sa.Integer), col('superset_id', sa.Text, True),
    parent='workout_pk', constraints=[link('workout_pk', 'planned_workouts', True), link('exercise_pk', 'exercises'),
        position_check(), check('rest_seconds', 'rest_seconds BETWEEN 0 AND 1800'),
        check('superset_id', 'superset_id IS NULL OR length(superset_id) > 0')])


def set_fields():
    return [col('kind', sa.Text), col('target_reps', sa.Integer), col('target_kg', sa.Numeric(asdecimal=False), True),
            col('chain_id', sa.Text, True)]


def set_checks():
    return [check('kind', "kind IN ('warmup', 'working', 'drop')"),
            check('target_reps', 'target_reps BETWEEN 1 AND 100'),
            check('target_kg', 'target_kg IS NULL OR target_kg BETWEEN 0 AND 2000'),
            check('chain_id', 'chain_id IS NULL OR length(chain_id) > 0')]


planned_sets = owned('planned_sets', col('block_pk', UUID(as_uuid=True)), ordered(), *set_fields(),
    parent='block_pk', constraints=[link('block_pk', 'planned_exercises', True), position_check(), *set_checks()])
workout_sessions = owned('workout_sessions', col('original_plan_id', sa.Text), col('original_workout_id', sa.Text),
    col('source_workout_pk', UUID(as_uuid=True), True), col('name', sa.Text), col('date', sa.Date),
    # Text retains the exact frontend UTC timestamp precision; checks enforce valid instants.
    col('started_at', sa.Text), col('completed_at', sa.Text, True), col('status', sa.Text), col('notes', sa.Text),
    col('timer_present', sa.Boolean), col('timer_end_at', sa.Numeric(asdecimal=False), True),
    col('timer_remaining', sa.Numeric(asdecimal=False), True), col('timer_duration', sa.Integer, True), constraints=[
        link('source_workout_pk', 'planned_workouts'), check('name', 'length(name) > 0'),
        check('original_ids', 'length(original_plan_id) > 0 AND length(original_workout_id) > 0'),
        check('status', "status IN ('active', 'completed')"),
        check('completion', "status <> 'completed' OR completed_at IS NOT NULL"),
        check('started_at', "started_at ~ '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z$' AND isfinite(started_at::timestamptz)"),
        check('completed_at', "completed_at IS NULL OR (completed_at ~ '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z$' AND isfinite(completed_at::timestamptz))"),
        check('notes', 'length(notes) <= 5000'),
        check('timer', "(NOT timer_present AND timer_end_at IS NULL AND timer_remaining IS NULL AND timer_duration IS NULL) OR (timer_present AND timer_remaining IS NOT NULL AND timer_duration IS NOT NULL AND timer_remaining >= 0 AND timer_remaining < 'Infinity'::numeric AND timer_duration BETWEEN 0 AND 1800 AND (timer_end_at IS NULL OR (timer_end_at > '-Infinity'::numeric AND timer_end_at < 'Infinity'::numeric)))")])
sa.Index('ix_workout_sessions_user_date', workout_sessions.c.user_id, workout_sessions.c.date)
sa.Index('ix_workout_sessions_source', workout_sessions.c.user_id, workout_sessions.c.source_workout_pk)
workout_exercises = owned('workout_exercises', col('session_pk', UUID(as_uuid=True)), ordered(),
    col('original_exercise_id', sa.Text), col('exercise_pk', UUID(as_uuid=True), True),
    col('name', sa.Text), col('load_mode', sa.Text), col('rest_seconds', sa.Integer),
    col('superset_id', sa.Text, True), col('notes', sa.Text), parent='session_pk', constraints=[
        link('session_pk', 'workout_sessions', True), link('exercise_pk', 'exercises'), position_check(),
        check('original_exercise_id', 'length(original_exercise_id) > 0'), check('name', 'length(name) > 0'),
        check('load_mode', "load_mode IN ('external', 'bodyweight')"),
        check('rest_seconds', 'rest_seconds BETWEEN 0 AND 1800'), check('notes', 'length(notes) <= 5000'),
        check('superset_id', 'superset_id IS NULL OR length(superset_id) > 0')])
sa.Index('ix_workout_exercises_history', workout_exercises.c.user_id, workout_exercises.c.original_exercise_id)
sa.Index('ix_workout_exercises_source', workout_exercises.c.user_id, workout_exercises.c.exercise_pk)
workout_sets = owned('workout_sets', col('block_pk', UUID(as_uuid=True)), ordered(), *set_fields(),
    col('kg', sa.Numeric(asdecimal=False), True), col('reps', sa.Integer, True),
    col('effort', sa.Numeric(asdecimal=False), True), col('done', sa.Boolean), parent='block_pk', constraints=[
        link('block_pk', 'workout_exercises', True), position_check(), *set_checks(),
        check('kg', 'kg IS NULL OR kg BETWEEN 0 AND 2000'), check('reps', 'reps IS NULL OR reps BETWEEN 1 AND 100'),
        check('effort', 'effort IS NULL OR effort BETWEEN 1 AND 10'), check('done', 'NOT done OR reps IS NOT NULL')])
schedule_overrides = owned('schedule_overrides', col('plan_pk', UUID(as_uuid=True)),
    col('workout_pk', UUID(as_uuid=True)), col('original_date', sa.Date), col('date', sa.Date), constraints=[
        link('plan_pk', 'training_plans', True), link('workout_pk', 'planned_workouts', True, extra=[('plan_pk', 'plan_pk')])])
sa.Index('ix_schedule_overrides_plan', schedule_overrides.c.user_id, schedule_overrides.c.plan_pk)
sa.Index('ix_schedule_overrides_workout', schedule_overrides.c.user_id, schedule_overrides.c.workout_pk)
sa.Index('ix_planned_exercises_source', planned_exercises.c.user_id, planned_exercises.c.exercise_pk)

# Aggregate roots carry the latest account-wide sequence used by the sync feed.
SYNC_ROOTS = [profiles, exercises, training_plans, workout_sessions, schedule_overrides]
for root in SYNC_ROOTS:
    root.append_column(sa.Column('sync_sequence', sa.BigInteger, nullable=False, server_default='0'))

sync_state = sa.Table('sync_state', metadata,
    sa.Column('user_id', UUID(as_uuid=True), primary_key=True),
    sa.Column('sequence', sa.BigInteger, nullable=False, server_default='0'),
)
mutation_receipts = sa.Table('mutation_receipts', metadata,
    sa.Column('user_id', UUID(as_uuid=True), primary_key=True),
    sa.Column('mutation_id', UUID(as_uuid=True), primary_key=True),
    sa.Column('request_hash', sa.String(64), nullable=False),
    sa.Column('status_code', sa.Integer, nullable=False),
    sa.Column('response_body', sa.Text, nullable=False),
    sa.Column('response_etag', sa.Text, nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
)
sa.Index('ix_mutation_receipts_created', mutation_receipts.c.created_at)

RLS_TABLES = [t for t in metadata.sorted_tables if 'user_id' in t.c]
OWNED_TABLES = [t for t in RLS_TABLES if 'version' in t.c]
