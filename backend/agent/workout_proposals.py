"""Create immutable workout edit previews; only explicit approval writes sessions."""
import json
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import sqlalchemy as sa
from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, ValidationError

try:
    from ..conversations import guard_proposal
    from ..database import set_identity
    from ..domain import Plan, Session
    from .. import schema as tables
    from ..store import Store, etag, validate_aggregate
except ImportError:
    from conversations import guard_proposal
    from database import set_identity
    from domain import Plan, Session
    import schema as tables
    from store import Store, etag, validate_aggregate


class WorkoutEditRequest(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    sessionId: str = Field(min_length=1, max_length=200)
    session: Session


class WorkoutStartRequest(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    planId: str = Field(min_length=1, max_length=200)
    workoutId: str = Field(min_length=1, max_length=200)


def validate_workout_edit(before: Session, after: Session, expected_status='completed'):
    if before.id != after.id:
        raise ValueError('Keep the existing session ID')
    if before.status != expected_status or after.status != expected_status:
        raise ValueError(f'Only {expected_status} workouts can be edited by this tool; keep status {expected_status}')
    if expected_status == 'active':
        for field in ('planId', 'workoutId', 'startedAt', 'completedAt', 'timer'):
            if getattr(before, field) != getattr(after, field):
                raise ValueError(f'Keep the active workout {field} unchanged; this tool does not finish workouts or reset rest timers')
    if before.model_dump() == after.model_dump():
        raise ValueError('The proposed workout is unchanged')
    values = [after.id, after.planId, after.workoutId,
              *(b.id for b in after.blocks), *(b.exerciseId for b in after.blocks),
              *(s.id for b in after.blocks for s in b.sets)]
    if any(len(value) > 200 for value in values):
        raise ValueError('Workout IDs must be at most 200 characters')
    validate_aggregate(after)


async def propose_workout_changes(database, user_id, arguments: str, *, expected_status='completed'):
    if len(arguments.encode('utf-8')) > 50_000:
        return {'error': 'Workout proposal input is too large'}
    try:
        args = WorkoutEditRequest.model_validate_json(arguments)
        if args.session.id != args.sessionId:
            raise ValueError('sessionId must match session.id')
    except (ValueError, ValidationError) as error:
        return {'error': 'Invalid workout proposal', 'details': str(error)[:1200]}
    async with database.sessions() as connection:
        async with connection.begin():
            await set_identity(connection, user_id)
            data = Store(connection, user_id)
            try:
                current, row = await data.read('sessions', args.sessionId)
            except HTTPException as error:
                if error.status_code != 404:
                    raise
                return {'error': 'Workout not found for this account'}
            try:
                validate_workout_edit(Session.model_validate(current), args.session, expected_status)
            except (ValueError, ValidationError, HTTPException) as error:
                return {'error': 'Invalid workout changes', 'details': str(error)[:1200]}
            return await _persist_workout(connection, user_id, args.session, current, etag(row))


async def active_workouts(data):
    return await data.rows(tables.workout_sessions, tables.workout_sessions.c.status == 'active')


def build_workout_start(plan: Plan, workout_id: str, exercises: dict, today) -> Session:
    workout = next((w for w in plan.workouts if w.id == workout_id), None)
    if workout is None:
        raise ValueError('Workout not found in this plan')
    now = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
    blocks = []
    for block in workout.blocks:
        exercise = exercises.get(block.exerciseId)
        if exercise is None:
            raise ValueError('The workout references an unavailable exercise')
        blocks.append({**block.model_dump(mode='json'), 'name': exercise['name'],
            'loadMode': exercise['loadMode'], 'notes': '', 'sets': [
                {**item.model_dump(mode='json'), 'kg': None, 'reps': None, 'effort': None, 'done': False}
                for item in block.sets]})
    return Session.model_validate({'id': str(uuid4()), 'planId': plan.id, 'workoutId': workout.id,
        'name': workout.name, 'date': today.isoformat(), 'startedAt': now, 'completedAt': None,
        'status': 'active', 'notes': '', 'timer': None, 'blocks': blocks})


async def propose_workout_start(database, user_id, arguments: str, today):
    try:
        args = WorkoutStartRequest.model_validate_json(arguments)
    except (ValueError, ValidationError) as error:
        return {'error': 'Invalid workout start', 'details': str(error)[:1200]}
    async with database.sessions() as connection:
        async with connection.begin():
            await set_identity(connection, user_id)
            data = Store(connection, user_id)
            active = await active_workouts(data)
            if active:
                return {'error': 'A workout is already active. Read it to resume or propose edits instead.',
                        'sessionIds': [row['client_id'] for row in active]}
            try:
                current, row = await data.read('plans', args.planId)
            except HTTPException as error:
                if error.status_code != 404:
                    raise
                return {'error': 'Plan not found for this account'}
            plan = Plan.model_validate(current)
            ids = [b.exerciseId for w in plan.workouts for b in w.blocks]
            catalog = await data.rows(tables.exercise_catalog, tables.exercise_catalog.c.client_id.in_(ids))
            owned = await data.rows(tables.exercises, tables.exercises.c.client_id.in_(ids))
            definitions = {item['id']: item for item in [
                *await data.documents('catalog', catalog), *await data.documents('exercises', owned)]}
            try:
                preview = build_workout_start(plan, args.workoutId, definitions, today)
            except (ValueError, ValidationError) as error:
                return {'error': 'Cannot start this workout', 'details': str(error)[:1200]}
            return await _persist_workout(connection, user_id, preview, None, None,
                                          plan_id=plan.id, plan_etag=etag(row))


async def _persist_workout(connection, user_id, preview, before, source_etag, *, plan_id=None, plan_etag=None):
    await guard_proposal(connection, user_id)
    now = datetime.now(timezone.utc)
    proposal_id = uuid4()
    kind = 'session_modify' if before is not None else 'session_create'
    label = f'Edit {preview.status} workout' if before is not None else 'Start workout'
    payload = {'id': str(proposal_id), 'type': kind,
        'targetSessionId': preview.id, 'sourceEtag': source_etag,
        'targetPlanId': plan_id, 'sourcePlanEtag': plan_etag,
        'beforeSession': before, 'session': preview.model_dump(mode='json'),
        'summary': f'{label}: {preview.name} ({preview.date})'[:1500],
        'createdAt': now.isoformat(), 'expiresAt': (now + timedelta(hours=24)).isoformat(), 'status': 'pending'}
    encoded = json.dumps(payload, separators=(',', ':'), allow_nan=False)
    if len(encoded.encode('utf-8')) > 40_000:
        return {'error': 'Workout proposal is too large to review'}
    await connection.execute(sa.text('''INSERT INTO fitcoach.coach_proposals
        (user_id, proposal_id, proposal_type, target_session_id, target_plan_id, source_etag,
         proposal_json, summary, status, expires_at)
        VALUES (:user, :id, :kind, :target, :plan, :etag, :payload, :summary, 'pending', :expires)'''),
        {'user': user_id, 'id': proposal_id, 'kind': kind, 'target': preview.id, 'plan': plan_id,
         'etag': source_etag if before is not None else plan_etag,
         'payload': encoded, 'summary': payload['summary'], 'expires': now + timedelta(hours=24)})
    return {'proposal': payload, 'summary': payload['summary']}
