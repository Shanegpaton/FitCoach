import json
from uuid import UUID

import pytest
import sqlalchemy as sa

from backend.agent.plan_proposal_service import create_proposal, modify_proposal
from backend.database import set_identity
from backend.tests.fixtures import exercise, headers, plan


@pytest.mark.asyncio
async def test_create_proposal_is_account_scoped_and_approval_is_idempotent(api):
    client, database, users, _ = api
    response = await client.get('/v1/coach/proposals/00000000-0000-0000-0000-000000000001')
    assert response.status_code == 401

    created = await create_proposal(database, users['a'], json.dumps({'plan': plan(), 'assumptions': ['four days']}))
    proposal_id = created['proposal']['id']
    assert created['proposal']['status'] == 'pending'
    assert (await client.get(f'/v1/coach/proposals/{proposal_id}', headers=headers('b'))).status_code == 404

    first = await client.post(f'/v1/coach/proposals/{proposal_id}/approve', headers=headers('a'))
    assert first.status_code == 200
    assert first.json()['plan']['id'] == 'plan'
    assert first.json()['proposal']['status'] == 'approved'
    assert first.json()['replayed'] is False
    second = await client.post(f'/v1/coach/proposals/{proposal_id}/approve', headers=headers('a'))
    assert second.status_code == 200
    assert second.json()['replayed'] is True
    stored = await client.get('/v1/plans/plan', headers=headers('a'))
    assert stored.status_code == 200
    assert stored.json() == first.json()['plan']


@pytest.mark.asyncio
async def test_rejection_does_not_mutate_and_stale_plan_proposal_is_invalidated(api):
    client, database, users, _ = api
    original = plan()
    created_response = await client.put('/v1/plans/plan', headers=headers('a'), json=original)
    assert created_response.status_code == 201
    etag = created_response.headers['etag']
    rejected = await create_proposal(database, users['a'], json.dumps({'plan': plan('new-plan'), 'assumptions': []}))
    reject_result = await client.post(f"/v1/coach/proposals/{rejected['proposal']['id']}/reject", headers=headers('a'))
    assert reject_result.status_code == 200 and reject_result.json()['status'] == 'rejected'
    assert (await client.get('/v1/plans/plan', headers=headers('a'))).json() == original

    change = await modify_proposal(database, users['a'], json.dumps({'planId': 'plan', 'assumptions': [],
        'operations': [{'type': 'rename_plan', 'name': 'Coach version'}]}))
    changed = {**original, 'name': 'Manual newer version', 'revision': original['revision'] + 1}
    latest = await client.put('/v1/plans/plan', headers=headers('a', etag), json=changed)
    assert latest.status_code == 200
    stale = await client.post(f"/v1/coach/proposals/{change['proposal']['id']}/approve", headers=headers('a'))
    assert stale.status_code == 409
    status = await client.get(f"/v1/coach/proposals/{change['proposal']['id']}", headers=headers('a'))
    assert status.json()['status'] == 'invalidated'
    assert (await client.get('/v1/plans/plan', headers=headers('a'))).json()['name'] == 'Manual newer version'


@pytest.mark.asyncio
async def test_deleted_exercise_at_approval_rolls_back_the_entire_plan_write(api):
    client, database, users, _ = api
    exercise_response = await client.put('/v1/exercises/custom', headers=headers('a'), json=exercise())
    assert exercise_response.status_code == 201
    candidate = plan()
    candidate['workouts'][0]['blocks'][0]['exerciseId'] = 'custom'
    created = await create_proposal(database, users['a'], json.dumps({'plan': candidate, 'assumptions': []}))
    deleted = await client.delete('/v1/exercises/custom', headers=headers('a', exercise_response.headers['etag']))
    assert deleted.status_code == 204
    result = await client.post(f"/v1/coach/proposals/{created['proposal']['id']}/approve", headers=headers('a'))
    assert result.status_code == 409
    assert (await client.get('/v1/plans/plan', headers=headers('a'))).status_code == 404
    status = await client.get(f"/v1/coach/proposals/{created['proposal']['id']}", headers=headers('a'))
    assert status.json()['status'] == 'invalidated'


@pytest.mark.asyncio
async def test_expired_proposal_cannot_be_approved(api):
    client, database, users, _ = api
    created = await create_proposal(database, users['a'], json.dumps({'plan': plan(), 'assumptions': []}))
    proposal_id = UUID(created['proposal']['id'])
    async with database.sessions() as session:
        async with session.begin():
            await set_identity(session, users['a'])
            await session.execute(sa.text('''UPDATE fitcoach.coach_proposals
                SET expires_at=now() - interval '1 second' WHERE proposal_id=:id'''), {'id': proposal_id})
    result = await client.post(f'/v1/coach/proposals/{proposal_id}/approve', headers=headers('a'))
    assert result.status_code == 409
    status = await client.get(f'/v1/coach/proposals/{proposal_id}', headers=headers('a'))
    assert status.json()['status'] == 'expired'
    assert (await client.get('/v1/plans/plan', headers=headers('a'))).status_code == 404
