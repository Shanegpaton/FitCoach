import json

import pytest

from backend.agent.workout_proposals import propose_workout_changes
from backend.tests.fixtures import headers, session


@pytest.mark.asyncio
async def test_workout_proposals_are_scoped_and_require_explicit_approval(api):
    client, database, users, _ = api
    original = session()
    stored = await client.put('/v1/sessions/session', headers=headers(), json=original)
    assert stored.status_code == 201
    after = session()
    after['blocks'][0]['sets'][0].update(reps=5, kg=35)
    candidate = json.dumps({'sessionId': 'session', 'session': after})
    foreign = await propose_workout_changes(database, users['b'], candidate)
    assert 'error' in foreign
    draft = (await propose_workout_changes(database, users['a'], candidate))['proposal']
    path = f"/v1/coach/proposals/{draft['id']}"
    assert draft['beforeSession'] == original
    assert draft['sourceEtag'] == stored.headers['etag']
    assert (await client.get('/v1/sessions/session', headers=headers())).json() == original
    for endpoint in (path, path + '/approve', path + '/reject'):
        response = await (client.get(endpoint, headers=headers('b')) if endpoint == path
                          else client.post(endpoint, headers=headers('b')))
        assert response.status_code == 404
    accepted = await client.post(path + '/approve', headers=headers())
    assert accepted.status_code == 200
    assert accepted.json()['session'] == after
    replay = await client.post(path + '/approve', headers=headers())
    assert replay.status_code == 200 and replay.json()['replayed'] is True
    assert replay.json()['etag'] == accepted.json()['etag']
    assert (await client.get('/v1/sessions/session', headers=headers())).json() == after
    # The recovery snapshot remains available after approval and later edits.
    assert (await client.get(path, headers=headers())).json()['beforeSession'] == original
    changes = (await client.get('/v1/sync/changes?cursor=0&limit=100', headers=headers())).json()
    assert any(item['resource'] == 'sessions' and item['id'] == 'session' for item in changes['items'])


@pytest.mark.asyncio
async def test_rejection_and_stale_approval_preserve_recorded_sets(api):
    client, database, users, _ = api
    original = session()
    stored = await client.put('/v1/sessions/session', headers=headers(), json=original)
    after = session()
    after['blocks'][0]['sets'][0]['reps'] = 5
    candidate = json.dumps({'sessionId': 'session', 'session': after})
    draft = (await propose_workout_changes(database, users['a'], candidate))['proposal']
    path = f"/v1/coach/proposals/{draft['id']}"
    assert (await client.post(path + '/reject', headers=headers())).status_code == 200
    assert (await client.post(path + '/approve', headers=headers())).status_code == 409
    assert (await client.get('/v1/sessions/session', headers=headers())).json() == original
    stale = (await propose_workout_changes(database, users['a'], candidate))['proposal']
    newer = session()
    newer['blocks'][0]['sets'][0]['reps'] = 12
    assert (await client.put('/v1/sessions/session', headers=headers(etag=stored.headers['etag']), json=newer)).status_code == 200
    stale_path = f"/v1/coach/proposals/{stale['id']}"
    assert (await client.post(stale_path + '/approve', headers=headers())).status_code == 409
    assert (await client.get(stale_path, headers=headers())).json()['status'] == 'invalidated'
    assert (await client.get('/v1/sessions/session', headers=headers())).json() == newer
    assert (await client.get(stale_path, headers=headers())).json()['beforeSession'] == original


@pytest.mark.asyncio
async def test_start_requires_approval_and_is_scoped_and_idempotent(api):
    from datetime import date
    from backend.agent.workout_proposals import propose_workout_start
    from backend.tests.fixtures import plan
    client, database, users, _ = api
    assert (await client.put('/v1/plans/plan', headers=headers(), json=plan())).status_code == 201
    arguments = json.dumps({'planId': 'plan', 'workoutId': 'workout-a'})
    assert 'error' in await propose_workout_start(database, users['b'], arguments, date.today())
    draft = (await propose_workout_start(database, users['a'], arguments, date.today()))['proposal']
    competitor = (await propose_workout_start(database, users['a'], arguments, date.today()))['proposal']
    assert (await client.get('/v1/sessions', headers=headers())).json()['items'] == []
    path = f"/v1/coach/proposals/{draft['id']}"
    assert (await client.post(path + '/approve', headers=headers('b'))).status_code == 404
    first = await client.post(path + '/approve', headers=headers())
    assert first.status_code == 200
    value = first.json()['session']
    assert value['status'] == 'active' and value['id'] == draft['targetSessionId']
    assert all(not s['done'] and s['reps'] is None and s['kg'] is None for b in value['blocks'] for s in b['sets'])
    replay = await client.post(path + '/approve', headers=headers())
    assert replay.status_code == 200 and replay.json()['replayed'] is True
    assert replay.json()['etag'] == first.json()['etag']
    assert len((await client.get('/v1/sessions', headers=headers())).json()['items']) == 1
    # A second draft cannot supersede an active workout or lose its recorded sets.
    assert (await client.post(f"/v1/coach/proposals/{competitor['id']}/approve", headers=headers())).status_code == 409
    blocked = await propose_workout_start(database, users['a'], arguments, date.today())
    assert blocked['sessionIds'] == [value['id']]
    assert (await client.get(f"/v1/sessions/{value['id']}", headers=headers())).json() == value


@pytest.mark.asyncio
async def test_start_rejects_stale_source_plan_and_rejection_creates_no_session(api):
    from datetime import date
    from backend.agent.workout_proposals import propose_workout_start
    from backend.tests.fixtures import plan
    client, database, users, _ = api
    source = plan()
    stored = await client.put('/v1/plans/plan', headers=headers(), json=source)
    arguments = json.dumps({'planId': 'plan', 'workoutId': 'workout-a'})
    draft = (await propose_workout_start(database, users['a'], arguments, date.today()))['proposal']
    rejected = (await propose_workout_start(database, users['a'], arguments, date.today()))['proposal']
    assert (await client.post(f"/v1/coach/proposals/{rejected['id']}/reject", headers=headers())).status_code == 200
    source.update(name='Updated plan', revision=source['revision'] + 1)
    assert (await client.put('/v1/plans/plan', headers=headers(etag=stored.headers['etag']), json=source)).status_code == 200
    assert (await client.post(f"/v1/coach/proposals/{draft['id']}/approve", headers=headers())).status_code == 409
    assert (await client.get('/v1/sessions', headers=headers())).json()['items'] == []


@pytest.mark.asyncio
async def test_active_edits_preserve_timer_and_refuse_to_overwrite_new_logged_sets(api):
    client, database, users, _ = api
    original = session(status='active')
    assert (await client.put('/v1/sessions/session', headers=headers(), json=original)).status_code == 201
    candidate = session(status='active')
    candidate['blocks'][0]['sets'][1]['targetReps'] = 12
    args = json.dumps({'sessionId': 'session', 'session': candidate})
    draft = (await propose_workout_changes(database, users['a'], args, expected_status='active'))['proposal']
    first = await client.post(f"/v1/coach/proposals/{draft['id']}/approve", headers=headers())
    assert first.status_code == 200
    assert first.json()['session']['timer'] == original['timer']
    candidate['notes'] = 'Another requested change'
    stale = (await propose_workout_changes(database, users['a'], json.dumps({'sessionId': 'session', 'session': candidate}), expected_status='active'))['proposal']
    newer = first.json()['session']
    newer['blocks'][0]['sets'].append({**newer['blocks'][0]['sets'][0], 'id': 'new-logged-set', 'reps': 6})
    assert (await client.put('/v1/sessions/session', headers=headers(etag=first.json()['etag']), json=newer)).status_code == 200
    assert (await client.post(f"/v1/coach/proposals/{stale['id']}/approve", headers=headers())).status_code == 409
    assert (await client.get('/v1/sessions/session', headers=headers())).json() == newer
