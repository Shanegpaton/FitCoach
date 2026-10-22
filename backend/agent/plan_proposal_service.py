"""Authenticated, durable proposal construction. No writes to plan aggregates."""
import json
from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

import sqlalchemy as sa
from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

try:
    from .. import schema as tables
    from ..database import lock_user_mutations, set_identity
    from ..domain import Plan
    from ..store import Store, etag
    from .plan_proposals import operations_adapter, apply_operations
except ImportError:
    import schema as tables
    from database import lock_user_mutations, set_identity
    from domain import Plan
    from store import Store, etag
    from agent.plan_proposals import operations_adapter, apply_operations


class CreateRequest(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    plan: dict = Field(max_length=100000)
    assumptions: list[str] = Field(max_length=10)

    @field_validator('assumptions')
    @classmethod
    def bounded_assumptions(cls, values):
        if any(not item.strip() or len(item) > 300 for item in values):
            raise ValueError('Assumptions must be nonblank and at most 300 characters')
        return values


class ModifyRequest(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    planId: str = Field(min_length=1, max_length=200)
    operations: list[dict] = Field(min_length=1, max_length=20)
    assumptions: list[str] = Field(max_length=10)

    @field_validator('assumptions')
    @classmethod
    def bounded_assumptions(cls, values):
        if any(not item.strip() or len(item) > 300 for item in values):
            raise ValueError('Assumptions must be nonblank and at most 300 characters')
        return values


def _summary(kind: str, plan: Plan, assumptions: list[str]) -> str:
    label = 'New plan' if kind == 'create' else 'Updated plan'
    detail = ', '.join(w.name for w in plan.workouts)
    description = f' — {plan.description.strip()}' if plan.description.strip() else ''
    suffix = f" Assumptions: {'; '.join(assumptions)}" if assumptions else ''
    return f'{label}: {plan.name}{description} ({detail}).{suffix}'[:1500]


async def create_proposal(database, user_id: UUID, arguments: str) -> dict:
    if len(arguments.encode('utf-8')) > 50_000:
        return {'error': 'Proposal input is too large. Reduce its size.'}
    try:
        args = CreateRequest.model_validate_json(arguments)
        plan = Plan.model_validate(args.plan)
        _validate_ids(plan)
        plan.active = True
    except (ValidationError, ValueError) as error:
        return {'error': 'Invalid plan proposal', 'details': str(error)[:1200]}
    async with database.sessions() as session:
        async with session.begin():
            await set_identity(session, user_id)
            data = Store(session, user_id)
            exercise_ids = await _available_exercises(data)
            if any(block.exerciseId not in exercise_ids for w in plan.workouts for block in w.blocks):
                return {'error': 'Unknown or unauthorized exercise ID. Search exercises and use their IDs.'}
            result = await _persist(session, user_id, 'create', None, None, plan, None, [], args.assumptions)
    return result


async def modify_proposal(database, user_id: UUID, arguments: str) -> dict:
    if len(arguments.encode('utf-8')) > 50_000:
        return {'error': 'Proposal input is too large. Reduce its size.'}
    try:
        args = ModifyRequest.model_validate_json(arguments)
        operations = operations_adapter.validate_python(args.operations)
    except (ValidationError, ValueError) as error:
        return {'error': 'Invalid plan operations', 'details': str(error)[:1200]}
    async with database.sessions() as session:
        async with session.begin():
            await set_identity(session, user_id)
            data = Store(session, user_id)
            try:
                current, row = await data.read('plans', args.planId)
            except HTTPException:
                return {'error': 'Plan not found for this account'}
            exercise_ids = await _available_exercises(data)
            current_plan = Plan.model_validate(current)
            try:
                preview = apply_operations(current_plan, operations, exercise_ids)
                _validate_ids(preview)
            except (ValueError, ValidationError) as error:
                return {'error': 'Plan changes are invalid', 'details': str(error)[:1200]}
            # Keep the plan ID and server-owned revision; the commit uses root ETag as
            # its concurrency token and the regular aggregate mutation path.
            preview.revision = current['revision'] + 1
            result = await _persist(session, user_id, 'modify', args.planId, etag(row), preview,
                                    current_plan,
                                    [op.model_dump(mode='json') for op in operations], args.assumptions)
    return result


async def _available_exercises(data: Store) -> set[str]:
    owned = await data.rows(tables.exercises)
    catalog = await data.rows(tables.exercise_catalog)
    return {row['client_id'] for row in owned} | {row['client_id'] for row in catalog}


def _validate_ids(plan: Plan) -> None:
    values = [plan.id, *(w.id for w in plan.workouts),
              *(block.id for w in plan.workouts for block in w.blocks),
              *(item.id for w in plan.workouts for block in w.blocks for item in block.sets),
              *(block.exerciseId for w in plan.workouts for block in w.blocks)]
    if any(len(value) > 200 for value in values):
        raise ValueError('Plan IDs must be at most 200 characters')


async def _persist(session, user_id, kind, target, source_etag, plan, before_plan, operations, assumptions):
    now = datetime.now(timezone.utc)
    proposal_id = uuid4()
    payload = {'id': str(proposal_id), 'type': kind, 'targetPlanId': target,
        'sourceEtag': source_etag, 'operations': operations, 'beforePlan': before_plan.model_dump(mode='json') if before_plan else None,
        'plan': plan.model_dump(mode='json'),
        'assumptions': assumptions, 'createdAt': now.isoformat(),
        'expiresAt': (now + timedelta(hours=24)).isoformat(), 'status': 'pending'}
    summary = _summary(kind, plan, assumptions)
    encoded = json.dumps(payload, separators=(',', ':'), allow_nan=False)
    if len(encoded.encode('utf-8')) > 40_000:
        return {'error': 'Proposal is too large to review. Reduce the number of workouts or exercises.'}
    await session.execute(sa.text('''INSERT INTO fitcoach.coach_proposals
        (user_id, proposal_id, proposal_type, target_plan_id, source_etag, proposal_json,
         summary, status, expires_at)
        VALUES (:user_id, :id, :kind, :target, :etag, :payload, :summary, 'pending', :expires)'''),
        {'user_id': user_id, 'id': proposal_id, 'kind': kind, 'target': target,
         'etag': source_etag, 'payload': encoded, 'summary': summary,
         'expires': now + timedelta(hours=24)})
    return {'proposal': payload, 'summary': summary}


async def read_proposal(database, user_id: UUID, proposal_id: UUID) -> dict:
    expired = False
    async with database.sessions() as session:
        async with session.begin():
            await set_identity(session, user_id)
            row = (await session.execute(sa.text('''SELECT proposal_json, status, expires_at
                FROM fitcoach.coach_proposals WHERE user_id=:user_id AND proposal_id=:id'''),
                {'user_id': user_id, 'id': proposal_id})).mappings().first()
    if not row: raise HTTPException(404, 'Proposal not found')
    result = json.loads(row['proposal_json'])
    status = row['status']
    if status == 'pending' and row['expires_at'] <= datetime.now(timezone.utc):
        status = 'expired'
        expired = True
    if expired:
        async with database.sessions() as session:
            async with session.begin():
                await set_identity(session, user_id)
                await session.execute(sa.text("UPDATE fitcoach.coach_proposals SET status='expired' WHERE user_id=:user_id AND proposal_id=:id AND status='pending'"),
                    {'user_id': user_id, 'id': proposal_id})
    result['status'] = status
    return result


async def reject_proposal(database, user_id: UUID, proposal_id: UUID) -> dict:
    async with database.sessions() as session:
        async with session.begin():
            await set_identity(session, user_id)
            result = await session.execute(sa.text('''UPDATE fitcoach.coach_proposals SET status='rejected'
                WHERE user_id=:user_id AND proposal_id=:id AND status='pending' AND expires_at > now()'''),
                {'user_id': user_id, 'id': proposal_id})
            if not result.rowcount:
                raise HTTPException(409, 'Proposal is no longer pending or has expired')
    return await read_proposal(database, user_id, proposal_id)


async def approve_proposal(database, user_id: UUID, proposal_id: UUID) -> dict:
    """Commit the immutable stored preview through Store.put and its sync versioning."""
    stale = False
    result = None
    async with database.sessions() as session:
        async with session.begin():
            await set_identity(session, user_id)
            await lock_user_mutations(session, user_id)
            row = (await session.execute(sa.text('''SELECT * FROM fitcoach.coach_proposals
                WHERE user_id=:user_id AND proposal_id=:id FOR UPDATE'''),
                {'user_id': user_id, 'id': proposal_id})).mappings().first()
            if not row:
                raise HTTPException(404, 'Proposal not found')
            payload = json.loads(row['proposal_json'])
            if row['status'] == 'approved':
                current, current_row = await Store(session, user_id).read('plans', payload['plan']['id'])
                result = {'proposal': payload | {'status': 'approved'}, 'plan': current, 'etag': etag(current_row), 'replayed': True}
            elif row['status'] != 'pending':
                raise HTTPException(409, f"Proposal is {row['status']}")
            elif row['expires_at'] <= datetime.now(timezone.utc):
                await session.execute(sa.text("UPDATE fitcoach.coach_proposals SET status='expired' WHERE proposal_id=:id"), {'id': proposal_id})
                stale = True
            else:
                data = Store(session, user_id)
                if row['proposal_type'] == 'modify':
                    current = await data.root(tables.training_plans, row['target_plan_id'], lock=True)
                    if current is None or etag(current) != row['source_etag']:
                        await session.execute(sa.text("UPDATE fitcoach.coach_proposals SET status='invalidated' WHERE proposal_id=:id"), {'id': proposal_id})
                        stale = True
                if not stale:
                    try:
                        plan = Plan.model_validate(payload['plan'])
                        async with session.begin_nested():
                            saved, saved_row, _ = await data.put('plans', plan, row['source_etag'], create_only=row['proposal_type'] == 'create')
                    except HTTPException as error:
                        if error.status_code in (404, 409, 412, 422, 428):
                            await session.execute(sa.text("UPDATE fitcoach.coach_proposals SET status='invalidated' WHERE proposal_id=:id"), {'id': proposal_id})
                            stale = True
                        else:
                            raise
                    else:
                        await session.execute(sa.text("UPDATE fitcoach.coach_proposals SET status='approved' WHERE proposal_id=:id"), {'id': proposal_id})
                        payload['status'] = 'approved'
                        result = {'proposal': payload, 'plan': saved, 'etag': etag(saved_row), 'replayed': False}
    if stale:
        raise HTTPException(409, 'Proposal expired, references unavailable data, or its plan changed. Create a fresh proposal.')
    return result
