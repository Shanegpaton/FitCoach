import asyncio
from copy import deepcopy
from uuid import uuid4

import pytest
import sqlalchemy as sa
from sqlalchemy.exc import IntegrityError

from backend import schema as s
from backend.database import set_identity
from backend.store import Store
from backend.tests.fixtures import exercise, headers, override, plan, profile, session


async def put(client, resource, body, user='a', tag=None):
    path = f'/v1/{resource}' if resource == 'profile' else f'/v1/{resource}/{body["id"]}'
    return await client.put(path, json=body, headers=headers(user, tag))


@pytest.mark.parametrize('resource,body', [('profile', profile()), ('exercises', exercise()),
    ('plans', plan()), ('sessions', session())])
async def test_exact_roundtrip_ownership_and_preconditions(api, resource, body):
    client, _, _, _ = api
    path = f'/v1/{resource}' if resource == 'profile' else f'/v1/{resource}/{body["id"]}'
    result = await put(client, resource, body)
    assert result.status_code == 201, result.text
    assert result.json() == body
    first = result.headers['etag']
    assert (await client.get(path, headers=headers())).json() == body
    assert (await client.get(path, headers=headers('b'))).status_code == 404
    assert (await put(client, resource, body)).status_code == 428
    assert (await put(client, resource, body, tag='"0"')).status_code == 412
    changed = await put(client, resource, body, tag=first)
    assert changed.status_code == 200, changed.text
    assert changed.headers['etag'] != first
    assert (await put(client, resource, body, tag=first)).status_code == 412
    assert (await put(client, resource, body, user='b')).status_code == 201
    if resource != 'profile':
        assert (await client.delete(path, headers=headers())).status_code == 428
        assert (await client.delete(path, headers=headers(etag=first))).status_code == 412
        assert (await client.delete(path, headers=headers(etag=changed.headers['etag']))).status_code == 204
        assert (await client.get(path, headers=headers())).status_code == 404
        assert (await put(client, resource, body)).status_code == 409
        assert (await client.get(path, headers=headers('b'))).status_code == 200


async def test_auth_and_public_health(api):
    client, db, users, calls = api
    assert (await client.get('/health')).json() == {'status': 'ok'}
    assert calls == []
    for value in [None, 'expired', 'unavailable']:
        response = await client.get('/v1/plans', headers=headers(value) if value else {})
        assert response.status_code == (503 if value == 'unavailable' else 401)
    assert (await client.get('/v1/me', headers=headers())).json() == {'id': str(users['a'])}
    # An unavailable database cannot prevent authentication-first failure or public health.
    original = db.sessions
    db.sessions = lambda: (_ for _ in ()).throw(AssertionError('Database opened before authentication'))
    assert (await client.get('/v1/plans', headers=headers('expired'))).status_code == 401
    assert (await client.get('/health')).status_code == 200
    db.sessions = original


async def test_catalog_owned_copy_and_custom_isolation(api):
    client, _, _, _ = api
    catalog = await client.get('/v1/catalog/ex-squat', headers=headers())
    assert catalog.status_code == 200
    assert (await client.put('/v1/catalog/ex-squat', json=catalog.json(), headers=headers())).status_code == 405
    assert (await put(client, 'plans', plan())).status_code == 201
    owned = await client.get('/v1/exercises/ex-squat', headers=headers())
    assert owned.json() == catalog.json()
    edited = owned.json() | {'name': 'Renamed squat'}
    assert (await put(client, 'exercises', edited, tag=owned.headers['etag'])).status_code == 200
    assert (await client.get('/v1/catalog/ex-squat', headers=headers())).json() == catalog.json()
    assert (await client.get('/v1/exercises/ex-squat', headers=headers('b'))).status_code == 404
    assert (await put(client, 'exercises', exercise())).status_code == 201
    own = plan('custom-plan')
    own['workouts'][0]['blocks'][0]['exerciseId'] = 'custom'
    assert (await put(client, 'plans', own, user='b')).status_code == 422
    assert (await client.get('/v1/plans/custom-plan', headers=headers('b'))).status_code == 404


async def test_snapshot_survives_source_edits_and_soft_deletion(api):
    client, db, users, _ = api
    original_plan = await put(client, 'plans', plan())
    original_session = await put(client, 'sessions', session())
    ex = await client.get('/v1/exercises/ex-squat', headers=headers())
    assert (await put(client, 'exercises', ex.json() | {'name': 'Changed source', 'loadMode': 'bodyweight'},
                      tag=ex.headers['etag'])).status_code == 200
    changed_plan = plan()
    changed_plan['workouts'][0]['name'] = 'Changed workout'
    changed_plan['workouts'][0]['blocks'][0]['sets'][0]['targetKg'] = 100
    updated = await put(client, 'plans', changed_plan, tag=original_plan.headers['etag'])
    assert updated.status_code == 200
    assert (await client.get('/v1/sessions/session', headers=headers())).json() == session()
    assert (await client.delete('/v1/plans/plan', headers=headers(etag=updated.headers['etag']))).status_code == 204
    ex = await client.get('/v1/exercises/ex-squat', headers=headers())
    assert (await client.delete('/v1/exercises/ex-squat', headers=headers(etag=ex.headers['etag']))).status_code == 204
    assert (await client.get('/v1/sessions/session', headers=headers())).json() == session()
    edited = session() | {'notes': 'Explicit history edit'}
    assert (await put(client, 'sessions', edited, tag=original_session.headers['etag'])).json() == edited
    # Deferred historical exercise relationships still require a valid owned source.
    async with db.sessions() as transaction:
        with pytest.raises(IntegrityError):
            async with transaction.begin():
                await set_identity(transaction, users['a'])
                await transaction.execute(s.workout_exercises.update().values(exercise_pk='00000000-0000-0000-0000-000000000000'))


async def test_missing_history_sources_and_repeated_session_ids(api):
    client, _, _, _ = api
    for id in ['one', 'two']:
        document = session(id)
        document['planId'] = 'missing-plan'
        document['workoutId'] = 'missing-workout'
        document['blocks'][0]['exerciseId'] = 'missing-exercise'
        result = await put(client, 'sessions', document)
        assert result.status_code == 201, result.text
        assert result.json() == document
        assert (await client.get(f'/v1/sessions/{id}', headers=headers())).json() == document
    assert len((await client.get('/v1/sessions', headers=headers())).json()['items']) == 2


async def test_nested_reorder_retains_identity_and_tombstones(api):
    client, db, users, _ = api
    document = plan()
    result = await put(client, 'plans', document)
    async with db.sessions() as transaction, transaction.begin():
        await set_identity(transaction, users['a'])
        before = (await transaction.execute(sa.select(s.planned_sets))).mappings().all()
    document['workouts'].reverse()
    document['workouts'][1]['days'].reverse()
    document['workouts'][1]['blocks'][0]['sets'].reverse()
    document['revision'] += 1
    updated = await put(client, 'plans', document, tag=result.headers['etag'])
    assert updated.status_code == 200, updated.text
    assert updated.json() == document
    assert (await client.get('/v1/plans/plan', headers=headers())).json() == document
    async with db.sessions() as transaction, transaction.begin():
        await set_identity(transaction, users['a'])
        after = (await transaction.execute(sa.select(s.planned_sets))).mappings().all()
        assert {r['pk'] for r in after} == {r['pk'] for r in before}
        assert all(r['version'] > next(b['version'] for b in before if b['pk'] == r['pk']) for r in after)
    omitted = deepcopy(document)
    omitted['workouts'].pop()
    removed = await put(client, 'plans', omitted, tag=updated.headers['etag'])
    assert removed.status_code == 200
    assert (await put(client, 'plans', document, tag=removed.headers['etag'])).status_code == 409
    assert (await client.get('/v1/plans/plan', headers=headers())).json() == omitted
    async with db.sessions() as transaction, transaction.begin():
        await set_identity(transaction, users['a'])
        assert await transaction.scalar(sa.select(sa.func.count()).select_from(s.planned_sets)
                                        .where(s.planned_sets.c.deleted_at.is_not(None))) == 2


async def test_override_integrity_and_cleanup(api):
    client, _, _, _ = api
    assert (await put(client, 'schedule-overrides', override())).status_code == 422
    first = await put(client, 'plans', plan())
    result = await put(client, 'schedule-overrides', override())
    assert result.status_code == 201, result.text
    assert result.json() == override()
    assert (await put(client, 'schedule-overrides', override())).status_code == 428
    assert (await client.get('/v1/schedule-overrides/override', headers=headers('b'))).status_code == 404
    document = plan()
    document['workouts'] = document['workouts'][1:]
    changed = await put(client, 'plans', document, tag=first.headers['etag'])
    assert changed.status_code == 200
    assert (await client.get('/v1/schedule-overrides/override', headers=headers())).status_code == 404
    assert (await client.get('/v1/schedule-overrides', headers=headers())).json()['items'] == []


async def test_activation_and_active_session_concurrency(api):
    client, _, _, _ = api
    results = await asyncio.gather(put(client, 'plans', plan('one', True)), put(client, 'plans', plan('two', True)))
    assert [r.status_code for r in results] == [201, 201]
    plans = (await client.get('/v1/plans', headers=headers())).json()['items']
    assert sum(p['active'] for p in plans) == 1
    results = await asyncio.gather(put(client, 'sessions', session('one', 'active')),
                                   put(client, 'sessions', session('two', 'active')))
    assert sorted(r.status_code for r in results) == [201, 201]
    assert len((await client.get('/v1/sessions', headers=headers())).json()['items']) == 2
    assert len((await client.get('/v1/sessions', headers=headers())).json()['items']) == 1


async def test_concurrent_stale_update(api):
    client, _, _, _ = api
    first = await put(client, 'plans', plan())
    results = await asyncio.gather(put(client, 'plans', plan() | {'name': 'One'}, tag=first.headers['etag']),
                                   put(client, 'plans', plan() | {'name': 'Two'}, tag=first.headers['etag']))
    assert sorted(r.status_code for r in results) == [200, 412]


async def test_rollback_after_database_child_failure(api, monkeypatch):
    client, _, _, _ = api
    original = Store.insert

    async def fail_child(self, table, values):
        if table is s.planned_sets:
            values['target_reps'] = 0  # Validated body becomes a database child check failure.
        return await original(self, table, values)

    monkeypatch.setattr(Store, 'insert', fail_child)
    assert (await put(client, 'plans', plan())).status_code == 409
    assert (await client.get('/v1/plans', headers=headers())).json()['items'] == []
    assert (await client.get('/v1/exercises', headers=headers())).json()['items'] == []
    monkeypatch.setattr(Store, 'insert', original)
    assert (await put(client, 'plans', plan())).status_code == 201


async def test_list_pagination_and_validation(api):
    client, _, _, _ = api
    for id in ['one', 'two', 'three']:
        assert (await put(client, 'exercises', exercise(id))).status_code == 201
    listing = (await client.get('/v1/exercises?limit=1&offset=1', headers=headers())).json()
    assert listing == {'items': [exercise('two')], 'limit': 1, 'offset': 1}
    assert (await client.get('/v1/plans?limit=501', headers=headers())).status_code == 422
    assert (await client.get('/v1/plans?offset=-1', headers=headers())).status_code == 422
    assert (await client.put('/v1/exercises/wrong', json=exercise(), headers=headers())).status_code == 422
    assert (await put(client, 'exercises', exercise() | {'user_id': 'forged'})).status_code == 422
    document = plan()
    document['workouts'][1]['days'] = [1]
    assert (await put(client, 'plans', document)).status_code == 422
    document = session()
    document['blocks'][0]['sets'][0]['kg'] = None
    assert (await put(client, 'sessions', document)).status_code == 422
    assert (await put(client, 'sessions', session() | {'date': '2026-02-30'})).status_code == 422


async def test_incremental_sync_feed_includes_updates_and_tombstones(api):
    client, _, _, _ = api
    created = await put(client, 'exercises', exercise('sync-lift'))
    first = await client.get('/v1/sync/changes?cursor=0&limit=1', headers=headers())
    assert first.status_code == 200, first.text
    page = first.json()
    assert page['items'][0]['resource'] == 'exercises'
    assert page['items'][0]['document'] == exercise('sync-lift')
    assert page['items'][0]['etag'] == created.headers['etag']
    assert page['cursor'] == page['highWater']
    changed = exercise('sync-lift') | {'name': 'Updated exercise'}
    result = await put(client, 'exercises', changed, tag=created.headers['etag'])
    delta = (await client.get(f"/v1/sync/changes?cursor={page['cursor']}", headers=headers())).json()
    assert len(delta['items']) == 1
    assert delta['items'][0]['document'] == changed
    assert delta['items'][0]['etag'] == result.headers['etag']
    deleted = await client.delete('/v1/exercises/sync-lift', headers=headers(etag=result.headers['etag']))
    assert deleted.status_code == 204
    tombstone = (await client.get(f"/v1/sync/changes?cursor={delta['cursor']}", headers=headers())).json()
    assert tombstone['items'][0]['deleted'] is True
    assert tombstone['items'][0]['document'] is None


async def test_sync_mutations_are_idempotent_and_reject_key_reuse(api):
    client, _, _, _ = api
    mutation_id = str(uuid4())
    body = {'mutations': [{'mutationId': mutation_id, 'resource': 'exercises', 'id': 'sync-lift',
        'operation': 'upsert', 'expectedEtag': None, 'payload': exercise('sync-lift')}]}
    first = await client.post('/v1/sync/mutations', json=body, headers=headers())
    assert first.status_code == 200, first.text
    result = first.json()['results'][0]
    assert result['status'] == 201
    replay = await client.post('/v1/sync/mutations', json=body, headers=headers())
    assert replay.json()['results'][0] == result
    changed = deepcopy(body)
    changed['mutations'][0]['payload']['name'] = 'Different content'
    reused = await client.post('/v1/sync/mutations', json=changed, headers=headers())
    assert reused.json()['results'][0]['status'] == 409
    assert (await client.get('/v1/exercises/sync-lift', headers=headers())).json()['name'] == 'My exercise'


async def test_sync_batches_commit_aggregate_results_independently(api):
    client, _, _, _ = api
    good_id, bad_id = str(uuid4()), str(uuid4())
    body = {'mutations': [
        {'mutationId': good_id, 'resource': 'exercises', 'id': 'good-lift', 'operation': 'upsert',
         'expectedEtag': None, 'payload': exercise('good-lift')},
        {'mutationId': bad_id, 'resource': 'exercises', 'id': 'bad-lift', 'operation': 'upsert',
         'expectedEtag': None, 'payload': exercise('bad-lift') | {'name': ''}},
    ]}
    result = await client.post('/v1/sync/mutations', json=body, headers=headers())
    assert [item['status'] for item in result.json()['results']] == [201, 422]
    assert (await client.get('/v1/exercises/good-lift', headers=headers())).status_code == 200
    assert (await client.get('/v1/exercises/bad-lift', headers=headers())).status_code == 404


async def test_override_crud_and_plan_deletion_cleanup(api):
    client, _, _, _ = api
    saved_plan = await put(client, 'plans', plan())
    first = await put(client, 'schedule-overrides', override())
    assert first.status_code == 201
    assert (await put(client, 'schedule-overrides', override(), tag='"0"')).status_code == 412
    document = override() | {'date': '2026-10-13'}
    changed = await put(client, 'schedule-overrides', document, tag=first.headers['etag'])
    assert changed.status_code == 200
    assert changed.json() == document
    assert (await client.delete('/v1/schedule-overrides/override', headers=headers())).status_code == 428
    assert (await client.delete('/v1/schedule-overrides/override', headers=headers(etag=changed.headers['etag']))).status_code == 204
    assert (await put(client, 'schedule-overrides', override())).status_code == 409
    assert (await put(client, 'schedule-overrides', override('second'))).status_code == 201
    assert (await client.delete('/v1/plans/plan', headers=headers(etag=saved_plan.headers['etag']))).status_code == 204
    assert (await client.get('/v1/schedule-overrides', headers=headers())).json()['items'] == []


async def test_existing_plan_rollback_preserves_activation_versions_and_children(api, monkeypatch):
    client, _, _, _ = api
    first = await put(client, 'plans', plan(active=True))
    second_document = plan('second')
    second = await put(client, 'plans', second_document)
    original_update = Store.update

    async def failing_update(self, table, pk, values):
        if table is s.planned_sets:
            values['target_reps'] = 0
        return await original_update(self, table, pk, values)

    monkeypatch.setattr(Store, 'update', failing_update)
    modified = deepcopy(second_document)
    modified['name'] = 'Must roll back'
    modified['active'] = True
    modified['workouts'].reverse()
    assert (await put(client, 'plans', modified, tag=second.headers['etag'])).status_code == 409
    current = await client.get('/v1/plans/second', headers=headers())
    assert current.json() == second_document
    assert current.headers['etag'] == second.headers['etag']
    current = await client.get('/v1/plans/plan', headers=headers())
    assert current.json() == plan(active=True)
    assert current.headers['etag'] == first.headers['etag']


async def test_logged_children_reorder_and_deletion_preserve_other_sessions(api):
    client, db, users, _ = api
    document = session()
    extra = deepcopy(document['blocks'][0])
    extra.update(id='block-b', exerciseId='missing', name='Bodyweight snapshot', loadMode='bodyweight')
    document['blocks'].append(extra)
    first = await put(client, 'sessions', document)
    other = await put(client, 'sessions', session('other'))
    assert first.status_code == other.status_code == 201
    document['blocks'].reverse()
    document['blocks'][0]['sets'].reverse()
    document['timer'] = None
    changed = await put(client, 'sessions', document, tag=first.headers['etag'])
    assert changed.status_code == 200
    assert changed.json() == document
    assert (await client.delete('/v1/sessions/session', headers=headers(etag=changed.headers['etag']))).status_code == 204
    assert (await client.get('/v1/sessions/other', headers=headers())).json() == session('other')
    async with db.sessions() as transaction, transaction.begin():
        await set_identity(transaction, users['a'])
        removed = await transaction.scalar(sa.select(s.workout_sessions.c.pk).where(s.workout_sessions.c.client_id == 'session'))
        blocks = (await transaction.execute(sa.select(s.workout_exercises).where(s.workout_exercises.c.session_pk == removed))).mappings().all()
        assert len(blocks) == 2 and all(b['deleted_at'] is not None for b in blocks)
        sets = (await transaction.execute(sa.select(s.workout_sets).where(s.workout_sets.c.block_pk.in_([b['pk'] for b in blocks])))).mappings().all()
        assert len(sets) == 4 and all(item['deleted_at'] is not None for item in sets)


async def test_weekday_can_be_removed_and_assigned_again(api):
    client, _, _, _ = api
    original = plan()
    first = await put(client, 'plans', original)
    without_day = deepcopy(original)
    without_day['workouts'][0]['days'] = [1]
    removed = await put(client, 'plans', without_day, tag=first.headers['etag'])
    restored = await put(client, 'plans', original, tag=removed.headers['etag'])
    assert restored.status_code == 200
    assert restored.json() == original


async def test_database_dependency_failure_returns_503(api, monkeypatch):
    client, db, _, _ = api
    def unavailable():
        raise sa.exc.TimeoutError('Pool exhausted')
    monkeypatch.setattr(db, 'sessions', unavailable)
    assert (await client.get('/v1/plans', headers=headers())).status_code == 503
    assert (await client.get('/health')).status_code == 200


async def test_aggregate_rules_are_rechecked_within_mutation_transaction(api):
    from backend.domain import Plan
    from fastapi import HTTPException
    client, db, users, _ = api
    parsed = Plan.model_validate(plan())
    parsed.cursor = 100
    with pytest.raises(HTTPException) as error:
        async with db.sessions() as transaction, transaction.begin():
            await set_identity(transaction, users['a'])
            await Store(transaction, users['a']).put('plans', parsed, None)
    assert error.value.status_code == 422
    assert (await client.get('/v1/plans', headers=headers())).json()['items'] == []
