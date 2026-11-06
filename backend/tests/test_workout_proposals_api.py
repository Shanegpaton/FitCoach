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
