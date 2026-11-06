"""Create immutable workout edit previews; only explicit approval writes history."""
import json
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import sqlalchemy as sa
from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, ValidationError

try:
    from ..conversations import guard_proposal
    from ..database import set_identity
    from ..domain import Session
    from ..store import Store, etag, validate_aggregate
except ImportError:
    from conversations import guard_proposal
    from database import set_identity
    from domain import Session
    from store import Store, etag, validate_aggregate


class WorkoutEditRequest(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    sessionId: str = Field(min_length=1, max_length=200)
    session: Session


def validate_workout_edit(before: Session, after: Session):
    if before.id != after.id:
        raise ValueError('Keep the existing session ID')
    if before.status != 'completed' or after.status != 'completed':
        raise ValueError('Only completed workouts can be edited by this tool; keep status completed')
    if before.model_dump() == after.model_dump():
        raise ValueError('The proposed workout is unchanged')
    values = [after.id, after.planId, after.workoutId,
              *(b.id for b in after.blocks), *(b.exerciseId for b in after.blocks),
              *(s.id for b in after.blocks for s in b.sets)]
    if any(len(value) > 200 for value in values):
        raise ValueError('Workout IDs must be at most 200 characters')
    validate_aggregate(after)


async def propose_workout_changes(database, user_id, arguments: str):
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
                validate_workout_edit(Session.model_validate(current), args.session)
            except (ValueError, ValidationError, HTTPException) as error:
                return {'error': 'Invalid workout changes', 'details': str(error)[:1200]}
            await guard_proposal(connection, user_id)
            now = datetime.now(timezone.utc)
            proposal_id = uuid4()
            payload = {'id': str(proposal_id), 'type': 'session_modify',
                'targetSessionId': args.sessionId, 'sourceEtag': etag(row),
                'beforeSession': current, 'session': args.session.model_dump(mode='json'),
                'summary': f'Edit completed workout: {args.session.name} ({args.session.date})'[:1500],
                'createdAt': now.isoformat(), 'expiresAt': (now + timedelta(hours=24)).isoformat(),
                'status': 'pending'}
            encoded = json.dumps(payload, separators=(',', ':'), allow_nan=False)
            if len(encoded.encode('utf-8')) > 40_000:
                return {'error': 'Workout proposal is too large to review'}
            await connection.execute(sa.text('''INSERT INTO fitcoach.coach_proposals
                (user_id, proposal_id, proposal_type, target_session_id, source_etag,
                 proposal_json, summary, status, expires_at)
                VALUES (:user, :id, 'session_modify', :target, :etag, :payload, :summary, 'pending', :expires)'''),
                {'user': user_id, 'id': proposal_id, 'target': args.sessionId, 'etag': etag(row),
                 'payload': encoded, 'summary': payload['summary'], 'expires': now + timedelta(hours=24)})
    return {'proposal': payload, 'summary': payload['summary']}
