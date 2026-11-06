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
