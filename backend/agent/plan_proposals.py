"""Strict, deterministic plan operation models used by Coach proposals.

This module deliberately only constructs previews. Persistence and approval must
be handled by the account sync protocol, never by the model tool itself.
"""
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, ValidationError

from ..domain import Plan, Workout, Block, Prescription


class Operation(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)


class RenamePlan(Operation):
    type: Literal['rename_plan']
    name: str = Field(min_length=1, max_length=100)


class UpdatePlanMetadata(Operation):
    type: Literal['update_plan_metadata']
    description: str | None = Field(max_length=2000)
    schedule: Literal['week', 'rotation'] | None
    cursor: int | None = Field(ge=0, le=29)
    active: bool | None


class RenameWorkout(Operation):
    type: Literal['rename_workout']
    workoutId: str = Field(min_length=1, max_length=200)
    name: str = Field(min_length=1, max_length=100)


class ReorderWorkouts(Operation):
    type: Literal['reorder_workouts']
    workoutIds: list[str] = Field(min_length=1, max_length=30)


class AddWorkout(Operation):
    type: Literal['add_workout']
    workout: Workout
    position: int = Field(ge=0, le=29)


class RemoveWorkout(Operation):
    type: Literal['remove_workout']
    workoutId: str = Field(min_length=1, max_length=200)


class AddExercise(Operation):
    type: Literal['add_exercise']
    workoutId: str = Field(min_length=1, max_length=200)
    block: Block
    position: int = Field(ge=0, le=49)


class RemoveExercise(Operation):
    type: Literal['remove_exercise']
    workoutId: str = Field(min_length=1, max_length=200)
    blockId: str = Field(min_length=1, max_length=200)


class ReplaceExercise(Operation):
    type: Literal['replace_exercise']
    workoutId: str = Field(min_length=1, max_length=200)
    blockId: str = Field(min_length=1, max_length=200)
    exerciseId: str = Field(min_length=1, max_length=200)


class ReorderExercises(Operation):
    type: Literal['reorder_exercises']
    workoutId: str = Field(min_length=1, max_length=200)
    blockIds: list[str] = Field(min_length=1, max_length=50)


class UpdatePrescription(Operation):
    type: Literal['update_prescription']
    workoutId: str = Field(min_length=1, max_length=200)
    blockId: str = Field(min_length=1, max_length=200)
    sets: list[Prescription] = Field(min_length=1, max_length=40)
    restSeconds: int = Field(ge=0, le=1800)


PlanOperation = Annotated[RenamePlan | UpdatePlanMetadata | RenameWorkout | ReorderWorkouts | AddWorkout |
    RemoveWorkout | AddExercise | RemoveExercise | ReplaceExercise | ReorderExercises |
    UpdatePrescription, Field(discriminator='type')]
operations_adapter = TypeAdapter(list[PlanOperation])


def apply_operations(plan: Plan, operations: list[PlanOperation], exercise_ids: set[str]) -> Plan:
    """Apply up to 20 typed operations to a copy and validate the final aggregate."""
    if not operations or len(operations) > 20:
        raise ValueError('A proposal must contain between 1 and 20 operations')
    result = plan.model_copy(deep=True)
    touched: dict[tuple[str, str], str] = {}
    for op in operations:
        if isinstance(op, RenamePlan):
            result.name = op.name.strip()
        elif isinstance(op, UpdatePlanMetadata):
            if op.description is None and op.schedule is None and op.cursor is None and op.active is None:
                raise ValueError('Plan metadata operation does not change any field')
            if op.description is not None: result.description = op.description
            if op.schedule is not None: result.schedule = op.schedule
            if op.cursor is not None: result.cursor = op.cursor
            if op.active is not None: result.active = op.active
        elif isinstance(op, RenameWorkout):
            workout = _workout(result, op.workoutId)
            workout.name = op.name.strip()
        elif isinstance(op, ReorderWorkouts):
            ids = [item.id for item in result.workouts]
            if len(set(op.workoutIds)) != len(ids) or set(op.workoutIds) != set(ids):
                raise ValueError('Workout order must include each existing workout exactly once')
            result.workouts = [next(w for w in result.workouts if w.id == key) for key in op.workoutIds]
            if result.schedule == 'week':
                # Weekday schedule order is visible and deterministic; day assignments stay attached.
                pass
        elif isinstance(op, AddWorkout):
            if any(w.id == op.workout.id for w in result.workouts): raise ValueError('Workout ID already exists')
            _check_exercises(op.workout.blocks, exercise_ids)
            result.workouts.insert(min(op.position, len(result.workouts)), op.workout)
        elif isinstance(op, RemoveWorkout):
            if not any(w.id == op.workoutId for w in result.workouts): raise ValueError('Workout not found')
            if len(result.workouts) == 1: raise ValueError('A plan must retain at least one workout')
            result.workouts = [w for w in result.workouts if w.id != op.workoutId]
            result.cursor = min(result.cursor, len(result.workouts) - 1)
        else:
            workout = _workout(result, op.workoutId)
            key = (op.workoutId, getattr(op, 'blockId', ''))
            if key[1] and touched.get(key) == op.type:
                raise ValueError('Proposal repeats an operation for the same exercise')
            if isinstance(op, AddExercise):
                _check_exercises([op.block], exercise_ids)
                if any(b.id == op.block.id for b in workout.blocks): raise ValueError('Exercise block ID already exists')
                workout.blocks.insert(min(op.position, len(workout.blocks)), op.block)
            elif isinstance(op, RemoveExercise):
                if not any(b.id == op.blockId for b in workout.blocks): raise ValueError('Exercise not found')
                if len(workout.blocks) == 1: raise ValueError('A workout must retain at least one exercise')
                workout.blocks = [b for b in workout.blocks if b.id != op.blockId]
            elif isinstance(op, ReplaceExercise):
                block = _block(workout, op.blockId)
                if op.exerciseId not in exercise_ids: raise ValueError('Unknown exercise ID')
                block.exerciseId = op.exerciseId
            elif isinstance(op, ReorderExercises):
                ids = [b.id for b in workout.blocks]
                if len(set(op.blockIds)) != len(ids) or set(op.blockIds) != set(ids):
                    raise ValueError('Exercise order must include each existing exercise exactly once')
                workout.blocks = [next(b for b in workout.blocks if b.id == key) for key in op.blockIds]
            elif isinstance(op, UpdatePrescription):
                block = _block(workout, op.blockId)
                block.sets = op.sets
                block.restSeconds = op.restSeconds
            if key[1]: touched[key] = op.type
    _check_exercises([b for w in result.workouts for b in w.blocks], exercise_ids)
    validated = Plan.model_validate(result.model_dump())
    if validated.model_dump() == plan.model_dump():
        raise ValueError('The proposed operations do not change the plan')
    return validated


def _workout(plan: Plan, workout_id: str) -> Workout:
    item = next((w for w in plan.workouts if w.id == workout_id), None)
    if item is None: raise ValueError('Workout not found')
    return item


def _block(workout: Workout, block_id: str) -> Block:
    item = next((b for b in workout.blocks if b.id == block_id), None)
    if item is None: raise ValueError('Exercise not found')
    return item


def _check_exercises(blocks: list[Block], exercise_ids: set[str]) -> None:
    if any(block.exerciseId not in exercise_ids for block in blocks):
        raise ValueError('Unknown or unauthorized exercise ID')
