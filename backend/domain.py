"""Camel-case documents matching frontend/src/domain.ts; ownership is never input."""
import re
from datetime import date, datetime
from typing import Annotated, Generic, Literal, TypeVar

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

ID = Annotated[str, Field(min_length=1)]
Day = Annotated[int, Field(strict=True, ge=0, le=6)]
Weight = Annotated[float, Field(strict=True, ge=0, le=2000, allow_inf_nan=False)]
Reps = Annotated[int, Field(strict=True, ge=1, le=100)]
Rest = Annotated[int, Field(strict=True, ge=0, le=1800)]
Name = Annotated[str, Field(min_length=1, max_length=100)]


class Document(BaseModel):
    model_config = ConfigDict(extra='forbid')


T = TypeVar('T')


class Page(Document, Generic[T]):
    items: list[T]
    limit: int
    offset: int


class Profile(Document):
    id: Literal['profile']
    goals: str = Field(max_length=2000)
    experience: str
    equipment: list[str]
    trainingDays: list[Day]
    sessionMinutes: int = Field(strict=True, ge=10, le=180)
    unit: Literal['lb', 'kg']
    onboardingDone: bool = Field(strict=True)


class Exercise(Document):
    id: ID
    name: Name
    muscle: str = Field(max_length=100)
    equipment: str = Field(max_length=100)
    loadMode: Literal['external', 'bodyweight']
    custom: bool = Field(strict=True)

    @field_validator('name', mode='before')
    @classmethod
    def trim(cls, value):
        return value.strip() if isinstance(value, str) else value


class Prescription(Document):
    id: ID
    kind: Literal['warmup', 'working', 'drop']
    targetReps: Reps
    targetKg: Weight | None
    chainId: ID | None


class Block(Document):
    id: ID
    exerciseId: ID
    restSeconds: Rest
    supersetId: ID | None
    sets: list[Prescription] = Field(min_length=1, max_length=40)

    @model_validator(mode='after')
    def unique_sets(self):
        unique(self.sets)
        return self


class Workout(Document):
    id: ID
    name: Name
    days: list[Day]
    blocks: list[Block] = Field(min_length=1, max_length=50)
    _trim = field_validator('name', mode='before')(Exercise.trim.__func__)

    @model_validator(mode='after')
    def unique_blocks(self):
        unique(self.blocks)
        return self


class Plan(Document):
    id: ID
    name: Name
    schedule: Literal['week', 'rotation']
    cursor: int = Field(strict=True, ge=0)
    revision: int = Field(strict=True, ge=0)
    active: bool = Field(strict=True)
    workouts: list[Workout] = Field(min_length=1, max_length=30)
    _trim = field_validator('name', mode='before')(Exercise.trim.__func__)

    @model_validator(mode='after')
    def aggregate(self):
        unique(self.workouts)
        if self.cursor >= len(self.workouts):
            raise ValueError('Invalid rotation cursor')
        days = [d for w in self.workouts for d in w.days]
        if self.schedule == 'week' and len(set(days)) != len(days):
            raise ValueError('Only one workout can be assigned to each weekday')
        return self


class LoggedSet(Prescription):
    kg: Weight | None
    reps: Reps | None
    effort: Annotated[float, Field(strict=True, ge=1, le=10, allow_inf_nan=False)] | None
    done: bool = Field(strict=True)

    @model_validator(mode='after')
    def completed(self):
        if self.done and self.reps is None:
            raise ValueError('Completed sets need reps')
        return self


class SessionBlock(Document):
    id: ID
    exerciseId: ID
    name: str = Field(min_length=1)
    loadMode: Literal['external', 'bodyweight']
    restSeconds: Rest
    supersetId: ID | None
    notes: str = Field(max_length=5000)
    sets: list[LoggedSet] = Field(min_length=1)

    @model_validator(mode='after')
    def aggregate(self):
        unique(self.sets)
        for item in self.sets:
            if item.done and self.loadMode == 'external' and item.kg is None:
                raise ValueError('Completed weighted sets need a load')
        return self


class Timer(Document):
    endAt: Annotated[float, Field(strict=True, allow_inf_nan=False)] | None
    remaining: Annotated[float, Field(strict=True, ge=0, allow_inf_nan=False)]
    duration: Rest


def calendar_date(value: str):
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
        raise ValueError('Invalid calendar date')
    date.fromisoformat(value)
    return value


def timestamp(value: str):
    # Zod datetime() accepts UTC Z timestamps, not local times or offsets.
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z', value):
        raise ValueError('Expected UTC ISO timestamp')
    datetime.fromisoformat(value.replace('Z', '+00:00'))
    return value


class Session(Document):
    id: ID
    planId: ID
    workoutId: ID
    name: str = Field(min_length=1)
    date: str
    startedAt: str
    completedAt: str | None
    status: Literal['active', 'completed']
    blocks: list[SessionBlock] = Field(min_length=1)
    timer: Timer | None
    notes: str = Field(max_length=5000)

    _date = field_validator('date')(calendar_date)
    _start = field_validator('startedAt')(timestamp)

    @field_validator('completedAt')
    @classmethod
    def end_time(cls, value):
        return timestamp(value) if value is not None else None

    @model_validator(mode='after')
    def aggregate(self):
        unique(self.blocks)
        if self.status == 'completed' and self.completedAt is None:
            raise ValueError('Completed sessions need a completion time')
        return self


class ScheduleOverride(Document):
    id: ID
    planId: ID
    workoutId: ID
    originalDate: str
    date: str
    _dates = field_validator('originalDate', 'date')(calendar_date)


def unique(items):
    if len({item.id for item in items}) != len(items):
        raise ValueError('Duplicate IDs within parent')
