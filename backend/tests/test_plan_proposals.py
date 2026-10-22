import pytest
from pydantic import ValidationError

from backend.domain import Plan
from backend.agent.plan_proposals import operations_adapter, apply_operations
from backend.tests.fixtures import plan


def test_update_prescription_is_a_typed_operation_and_preview_is_deterministic():
    source = Plan.model_validate(plan())
    raw = {'type': 'update_prescription', 'workoutId': 'workout-a', 'blockId': 'block-a',
           'sets': [{'id': 'set-1', 'kind': 'working', 'targetReps': 5,
                     'targetKg': None, 'chainId': None}], 'restSeconds': 180}
    operations = operations_adapter.validate_python([raw])
    first = apply_operations(source, operations, {'ex-squat', 'ex-pushup'})
    second = apply_operations(source, operations, {'ex-squat', 'ex-pushup'})
    assert first.model_dump() == second.model_dump()
    assert first.workouts[0].blocks[0].sets[0].targetReps == 5
    assert source.workouts[0].blocks[0].sets[0].targetReps != 5


def test_unknown_operation_and_unknown_fields_are_rejected():
    with pytest.raises(ValidationError):
        operations_adapter.validate_python([{'type': 'execute_sql', 'sql': 'select 1'}])
    with pytest.raises(ValidationError):
        operations_adapter.validate_python([{'type': 'rename_plan', 'name': 'A', 'accountId': 'x'}])


def test_invalid_exercise_and_oversized_operations_are_rejected():
    source = Plan.model_validate(plan())
    operations = operations_adapter.validate_python([{'type': 'replace_exercise',
        'workoutId': 'workout-a', 'blockId': 'block-a', 'exerciseId': 'missing'}])
    with pytest.raises(ValueError, match='Unknown'):
        apply_operations(source, operations, {'ex-squat', 'ex-pushup'})
    with pytest.raises(ValueError, match='20'):
        apply_operations(source, operations * 21, {'ex-squat', 'ex-pushup'})


def test_add_remove_replace_and_reorder_operations_build_a_full_preview():
    source = Plan.model_validate(plan())
    added_block = {'id': 'new-block', 'exerciseId': 'ex-squat', 'restSeconds': 60,
        'supersetId': None, 'sets': [{'id': 'new-set', 'kind': 'working', 'targetReps': 12,
        'targetKg': None, 'chainId': None}]}
    operations = operations_adapter.validate_python([
        {'type': 'add_exercise', 'workoutId': 'workout-a', 'block': added_block, 'position': 0},
        {'type': 'replace_exercise', 'workoutId': 'workout-a', 'blockId': 'block-a', 'exerciseId': 'ex-pushup'},
        {'type': 'update_prescription', 'workoutId': 'workout-a', 'blockId': 'block-a',
         'sets': [{'id': 'set-a', 'kind': 'working', 'targetReps': 6, 'targetKg': None, 'chainId': None}],
         'restSeconds': 180},
        {'type': 'reorder_workouts', 'workoutIds': ['workout-b', 'workout-a']},
        {'type': 'rename_plan', 'name': 'Revised'}])
    preview = apply_operations(source, operations, {'ex-squat', 'ex-pushup'})
    assert preview.name == 'Revised'
    assert [w.id for w in preview.workouts] == ['workout-b', 'workout-a']
    assert preview.workouts[1].blocks[0].id == 'new-block'
    assert preview.workouts[1].blocks[1].exerciseId == 'ex-pushup'
    assert preview.workouts[1].blocks[1].sets[0].targetReps == 6


def test_removal_reorder_and_metadata_operations():
    source = Plan.model_validate(plan())
    operations = operations_adapter.validate_python([
        {'type': 'remove_workout', 'workoutId': 'workout-b'},
        {'type': 'update_plan_metadata', 'description': None, 'schedule': 'rotation', 'cursor': 0, 'active': True}])
    preview = apply_operations(source, operations, {'ex-squat', 'ex-pushup'})
    assert [w.id for w in preview.workouts] == ['workout-a']
    assert preview.schedule == 'rotation' and preview.active


def test_add_workout_and_replace_an_exercise_slot_by_add_remove():
    source = Plan.model_validate(plan())
    block = {'id': 'replacement-block', 'exerciseId': 'ex-pushup', 'restSeconds': 90,
        'supersetId': None, 'sets': [{'id': 'replacement-set', 'kind': 'working', 'targetReps': 10,
        'targetKg': None, 'chainId': None}]}
    workout = {'id': 'workout-c', 'name': 'Workout C', 'days': [4], 'blocks': [block]}
    operations = operations_adapter.validate_python([
        {'type': 'add_workout', 'workout': workout, 'position': 2},
        {'type': 'remove_workout', 'workoutId': 'workout-b'},
        {'type': 'add_exercise', 'workoutId': 'workout-a', 'block': {**block, 'id': 'new-slot'}, 'position': 0},
        {'type': 'remove_exercise', 'workoutId': 'workout-a', 'blockId': 'block-a'}])
    preview = apply_operations(source, operations, {'ex-squat', 'ex-pushup'})
    assert [w.id for w in preview.workouts] == ['workout-a', 'workout-c']
    assert [b.id for b in preview.workouts[0].blocks] == ['new-slot']


def test_invalid_ranges_missing_ids_and_noop_modifications_fail():
    with pytest.raises(ValidationError):
        operations_adapter.validate_python([{'type': 'update_prescription', 'workoutId': 'workout-a',
            'blockId': 'block-a', 'sets': [], 'restSeconds': -1}])
    source = Plan.model_validate(plan())
    missing = operations_adapter.validate_python([{'type': 'remove_exercise',
        'workoutId': 'workout-a', 'blockId': 'missing'}])
    with pytest.raises(ValueError, match='not found'):
        apply_operations(source, missing, {'ex-squat', 'ex-pushup'})
    noop = operations_adapter.validate_python([{'type': 'rename_plan', 'name': source.name}])
    with pytest.raises(ValueError, match='do not change'):
        apply_operations(source, noop, {'ex-squat', 'ex-pushup'})
