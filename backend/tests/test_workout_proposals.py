import json
from copy import deepcopy
from datetime import date
from uuid import uuid4

import pytest
from pydantic import ValidationError

from backend.agent.workout_proposals import WorkoutEditRequest, validate_workout_edit
from backend.agent.tools.database import TOOL_SPECS, run_database_tool
from backend.domain import Session
from backend.tests.fixtures import session


def test_workout_edit_schema_is_a_complete_snapshot_with_resolved_refs():
    params = next(t['parameters'] for t in TOOL_SPECS if t['name'] == 'propose_workout_changes')
    snapshot = params['properties']['session']
    assert snapshot['type'] == 'object'
    assert snapshot['additionalProperties'] is False
    assert set(snapshot['properties']) == set(snapshot['required'])
    assert snapshot['properties']['blocks']['type'] == 'array'
    ref = snapshot['properties']['blocks']['items']['$ref'].removeprefix('#/$defs/')
    assert params['$defs'][ref]['type'] == 'object'
    request = WorkoutEditRequest.model_validate_json(json.dumps({'sessionId': 'session', 'session': session()}))
    assert request.session.model_dump() == session()


def test_corrections_additions_removals_and_ordering_preserve_the_source_snapshot():
    source = Session.model_validate(session())
    before = source.model_dump()
    edited = deepcopy(before)
    edited.update(name='Corrected workout', date='2026-10-10', notes='Corrected notes')
    block = edited['blocks'][0]
    block.update(name='Recorded squat', restSeconds=180, notes='Corrected exercise notes')
    block['sets'][0].update(reps=6, kg=35, effort=8, targetReps=6)
    block['sets'].append({**block['sets'][0], 'id': 'new-set', 'reps': 4})
    block['sets'].pop(1)
    block['sets'].reverse()
    edited['blocks'].insert(0, {**deepcopy(block), 'id': 'new-block', 'exerciseId': 'historical-exercise'})
    after = Session.model_validate(edited)
    validate_workout_edit(source, after)
    assert after.blocks[1].sets[0].id == 'new-set'
    assert source.model_dump() == before


@pytest.mark.parametrize('change', [
    {'id': 'different-session'}, {'status': 'active'},
])
def test_identity_and_completed_status_cannot_be_changed(change):
    source = Session.model_validate(session())
    after = Session.model_validate({**source.model_dump(), **change})
    with pytest.raises(ValueError):
        validate_workout_edit(source, after)


def test_noop_and_active_sources_are_rejected():
    source = Session.model_validate(session())
    with pytest.raises(ValueError, match='unchanged'):
        validate_workout_edit(source, source.model_copy(deep=True))
    active = Session.model_validate(session(status='active'))
    with pytest.raises(ValueError, match='completed'):
        validate_workout_edit(active, source)


@pytest.mark.parametrize('change', [{'reps': None}, {'kg': None}, {'reps': 0}, {'kg': -5}])
def test_invalid_recorded_sets_are_rejected(change):
    value = session()
    value['blocks'][0]['sets'][0].update(change)
    with pytest.raises(ValidationError):
        WorkoutEditRequest.model_validate_json(json.dumps({'sessionId': value['id'], 'session': value}))


@pytest.mark.asyncio
async def test_invalid_workout_tool_arguments_never_open_the_database():
    class NoDatabase:
        def sessions(self):
            raise AssertionError('Invalid proposal must not access database')

    value = session()
    for arguments in ('{}', json.dumps({'sessionId': 'wrong-id', 'session': value})):
        result = await run_database_tool('propose_workout_changes', arguments, NoDatabase(), uuid4(), date.today())
        assert json.loads(result)['error'] == 'Invalid workout proposal'


def test_start_workout_builds_an_independent_active_snapshot_without_logged_results():
    from backend.agent.workout_proposals import build_workout_start
    from backend.domain import Plan
    from backend.tests.fixtures import plan
    source = Plan.model_validate(plan())
    before = source.model_dump()
    definitions = {'ex-squat': {'name': 'Squat at workout start', 'loadMode': 'external'}}
    result = build_workout_start(source, 'workout-a', definitions, date(2026, 11, 6))
    assert result.status == 'active' and result.completedAt is None and result.timer is None
    assert result.planId == source.id and result.workoutId == 'workout-a'
    assert result.date == '2026-11-06'
    assert result.blocks[0].name == 'Squat at workout start'
    assert result.blocks[0].sets[1].targetKg == source.workouts[0].blocks[0].sets[1].targetKg
    assert all(not s.done and s.kg is None and s.reps is None and s.effort is None for b in result.blocks for s in b.sets)
    result.blocks[0].sets[0].targetReps = 5
    assert source.model_dump() == before
    assert build_workout_start(source, 'workout-a', definitions, date.today()).id != result.id
    with pytest.raises(ValueError, match='not found'):
        build_workout_start(source, 'missing', definitions, date.today())
    with pytest.raises(ValueError, match='unavailable'):
        build_workout_start(source, 'workout-a', {}, date.today())


def test_active_workout_edits_preserve_recorded_sets_and_the_rest_deadline():
    before = Session.model_validate(session(status='active'))
    snapshot = before.model_dump()
    after = before.model_copy(deep=True)
    after.blocks[0].sets[1].targetReps = 12
    after.blocks[0].restSeconds = 120
    validate_workout_edit(before, after, 'active')
    assert after.blocks[0].sets[0] == before.blocks[0].sets[0]
    assert after.timer == before.timer
    assert before.model_dump() == snapshot


@pytest.mark.parametrize('field,value', [
    ('id', 'different'), ('status', 'completed'), ('planId', 'another-plan'),
    ('workoutId', 'another-workout'), ('startedAt', '2026-11-06T00:00:00Z'),
    ('completedAt', '2026-11-06T01:00:00Z'), ('timer', None),
])
def test_active_edit_cannot_finish_reidentify_or_reset_timer(field, value):
    before = Session.model_validate(session(status='active'))
    changed = before.model_dump()
    changed[field] = value
    if field == 'status': changed['completedAt'] = '2026-11-06T01:00:00Z'
    after = Session.model_validate(changed)
    with pytest.raises(ValueError):
        validate_workout_edit(before, after, 'active')


@pytest.mark.asyncio
async def test_new_tool_schemas_and_invalid_arguments_fail_before_database_access():
    from backend.agent.workout_proposals import WorkoutStartRequest
    from backend.agent.tools.database import ARG_MODELS
    specs = {t['name']: t['parameters'] for t in TOOL_SPECS}
    assert set(specs['propose_start_workout']['properties']) == {'planId', 'workoutId'}
    assert ARG_MODELS['propose_start_workout'] is WorkoutStartRequest
    assert specs['propose_active_workout_changes']['properties']['session']['type'] == 'object'
    class NoDatabase:
        def sessions(self): raise AssertionError('Invalid tool arguments accessed database')
    for name in ('propose_start_workout', 'propose_active_workout_changes'):
        result = json.loads(await run_database_tool(name, '{}', NoDatabase(), uuid4(), date.today()))
        assert 'error' in result
