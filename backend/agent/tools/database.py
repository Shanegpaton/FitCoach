"""Allowlisted, account-scoped read tools for Coach. Model arguments never become SQL."""

import base64
import binascii
import calendar
import hashlib
import json
from datetime import date, timedelta
from typing import Literal
from uuid import UUID

import sqlalchemy as sa
from fastapi.encoders import jsonable_encoder
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

try:
    from ... import schema as tables
    from ...database import set_identity
    from ...store import Store
except ImportError:  # backend/ as the deployment project root
    import schema as tables
    from database import set_identity
    from store import Store

from ..inference import InferenceError

MAX_RESULT_CHARS = 24_000
MAX_PAGE_OFFSET = 5_000


def _nullable(kind: str) -> dict:
    return {'type': [kind, 'null']}


def _strings() -> dict:
    return {'type': 'array', 'items': {'type': 'string'}}


DATE_FIELDS = {
    'fromDate': _nullable('string'), 'toDate': _nullable('string'),
    'relativeMode': {'type': ['string', 'null'], 'enum': ['past', 'around', None]},
    'relativeUnit': {'type': ['string', 'null'], 'enum': ['days', 'weeks', 'months', 'years', None]},
    'relativeAmount': _nullable('integer'), 'windowDays': _nullable('integer'),
}
SESSION_FIELDS = {
    **DATE_FIELDS, 'sessionIds': _strings(), 'planIds': _strings(),
    'workoutIds': _strings(), 'workoutNames': _strings(),
    'exerciseIds': _strings(), 'exerciseNames': _strings(),
    'status': {'type': 'string', 'enum': ['completed', 'active', 'all']},
    'sort': {'type': 'string', 'enum': ['newest', 'oldest', 'nearest']},
    'limit': {'type': 'integer'}, 'cursor': _nullable('string'),
}


def _spec(name: str, description: str, properties: dict) -> dict:
    return {'type': 'function', 'name': name, 'description': description, 'strict': True,
            'parameters': {'type': 'object', 'properties': properties,
                           'required': list(properties), 'additionalProperties': False}}


TOOL_SPECS = [
    _spec('search_workout_sessions', 'Find compact workout sessions. Combine ID, recorded-name, date, and status filters. Use nearest with an around date for questions such as a year ago.', SESSION_FIELDS),
    _spec('get_workout_sessions', 'Read complete historical workout snapshots, including recorded exercises, sets, and notes, by session IDs.', {'ids': _strings()}),
    _spec('get_exercise_history', 'Read matching recorded exercise sets and simple performance totals over a filtered time period.', {**SESSION_FIELDS, 'includeIncomplete': {'type': 'boolean'}}),
    _spec('get_training_profile', 'Read the account training profile and preferred weight unit.', {}),
    _spec('search_training_plans', 'Find current or inactive plan summaries by ID or name.', {
        'ids': _strings(), 'names': _strings(), 'active': _nullable('boolean'),
        'limit': {'type': 'integer'}, 'cursor': _nullable('string')}),
    _spec('get_training_plans', 'Read complete current plan definitions by plan IDs.', {'ids': _strings()}),
    _spec('search_exercises', 'Find account and shared-catalog exercise definitions by ID or name.', {
        'ids': _strings(), 'names': _strings(), 'custom': _nullable('boolean'),
        'limit': {'type': 'integer'}, 'cursor': _nullable('string')}),
]


class ToolArgs(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)


class DateArgs(ToolArgs):
    from_date: date | None = Field(alias='fromDate')
    to_date: date | None = Field(alias='toDate')
    relative_mode: Literal['past', 'around'] | None = Field(alias='relativeMode')
    relative_unit: Literal['days', 'weeks', 'months', 'years'] | None = Field(alias='relativeUnit')
    relative_amount: int | None = Field(alias='relativeAmount', ge=0, le=50)
    window_days: int | None = Field(alias='windowDays', ge=0, le=365)

    @model_validator(mode='after')
    def valid_date_filter(self):
        if self.relative_mode is None:
            if any(value is not None for value in (self.relative_unit, self.relative_amount, self.window_days)):
                raise ValueError('Relative date fields require relativeMode')
            if self.from_date and self.to_date and self.from_date > self.to_date:
                raise ValueError('fromDate must be on or before toDate')
        elif (self.from_date is not None or self.to_date is not None
              or self.relative_unit is None or self.relative_amount is None):
            raise ValueError('Use either absolute dates or a complete relative date filter')
        elif self.relative_mode == 'past' and self.window_days is not None:
            raise ValueError('windowDays is only used with around')
        return self

    def resolve(self, today: date) -> tuple[date | None, date | None, date | None]:
        if self.relative_mode is None:
            center = self.from_date if self.from_date == self.to_date else None
            return self.from_date, self.to_date, center
        center = _subtract(today, self.relative_amount, self.relative_unit)
        if self.relative_mode == 'past':
            return center, today, None
        radius = self.window_days if self.window_days is not None else 45
        return center - timedelta(days=radius), center + timedelta(days=radius), center


class SessionSearch(DateArgs):
    session_ids: list[str] = Field(alias='sessionIds', max_length=20)
    plan_ids: list[str] = Field(alias='planIds', max_length=20)
    workout_ids: list[str] = Field(alias='workoutIds', max_length=20)
    workout_names: list[str] = Field(alias='workoutNames', max_length=10)
    exercise_ids: list[str] = Field(alias='exerciseIds', max_length=20)
    exercise_names: list[str] = Field(alias='exerciseNames', max_length=10)
    status: Literal['completed', 'active', 'all']
    sort: Literal['newest', 'oldest', 'nearest']
    limit: int = Field(ge=1, le=25)
    cursor: str | None = Field(max_length=256)

    @field_validator('session_ids', 'plan_ids', 'workout_ids', 'workout_names', 'exercise_ids', 'exercise_names')
    @classmethod
    def bounded_terms(cls, items: list[str]) -> list[str]:
        if any(not item.strip() or len(item) > 100 for item in items):
            raise ValueError('Filter terms must be nonblank and at most 100 characters')
        return items

    @model_validator(mode='after')
    def nearest_has_anchor(self):
        if self.sort == 'nearest' and self.relative_mode != 'around' and not (
            self.from_date is not None and self.from_date == self.to_date
        ):
            raise ValueError('nearest requires an around period or one exact date')
        return self


class ExerciseHistory(SessionSearch):
    include_incomplete: bool = Field(alias='includeIncomplete')

    @model_validator(mode='after')
    def exercise_required(self):
        if not self.exercise_ids and not self.exercise_names:
            raise ValueError('Specify exerciseIds or exerciseNames')
        if self.limit > 20:
            raise ValueError('Exercise history limit cannot exceed 20')
        return self


class RecordIds(ToolArgs):
    ids: list[str] = Field(min_length=1, max_length=3)

    @field_validator('ids')
    @classmethod
    def valid_ids(cls, items: list[str]) -> list[str]:
        if len(set(items)) != len(items) or any(not item.strip() or len(item) > 200 for item in items):
            raise ValueError('IDs must be unique, nonblank, and at most 200 characters')
        return items


class ProfileArgs(ToolArgs):
    pass


class PlanSearch(ToolArgs):
    ids: list[str] = Field(max_length=20)
    names: list[str] = Field(max_length=10)
    active: bool | None
    limit: int = Field(ge=1, le=25)
    cursor: str | None = Field(max_length=256)

    @field_validator('ids', 'names')
    @classmethod
    def bounded_terms(cls, items: list[str]) -> list[str]:
        return SessionSearch.bounded_terms(items)


class ExerciseSearch(ToolArgs):
    ids: list[str] = Field(max_length=20)
    names: list[str] = Field(max_length=10)
    custom: bool | None
    limit: int = Field(ge=1, le=25)
    cursor: str | None = Field(max_length=256)

    @field_validator('ids', 'names')
    @classmethod
    def bounded_terms(cls, items: list[str]) -> list[str]:
        return SessionSearch.bounded_terms(items)


ARG_MODELS = {
    'search_workout_sessions': SessionSearch,
    'get_workout_sessions': RecordIds,
    'get_exercise_history': ExerciseHistory,
    'get_training_profile': ProfileArgs,
    'search_training_plans': PlanSearch,
    'get_training_plans': RecordIds,
    'search_exercises': ExerciseSearch,
}


def _subtract(today: date, amount: int, unit: str) -> date:
    if unit == 'days':
        return today - timedelta(days=amount)
    if unit == 'weeks':
        return today - timedelta(weeks=amount)
    months = amount * (12 if unit == 'years' else 1)
    year, month = divmod(today.year * 12 + today.month - 1 - months, 12)
    month += 1
    return date(year, month, min(today.day, calendar.monthrange(year, month)[1]))


def _name_match(column, names: list[str]):
    return sa.or_(*(column.ilike('%' + name.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_') + '%', escape='\\')
                    for name in names))


def _session_statement(args: SessionSearch, user_id: UUID, today: date):
    session = tables.workout_sessions
    block = tables.workout_exercises
    start, end, center = args.resolve(today)
    stmt = sa.select(session).where(session.c.user_id == user_id, session.c.deleted_at.is_(None))
    if start is not None:
        stmt = stmt.where(session.c.date >= start)
    if end is not None:
        stmt = stmt.where(session.c.date <= end)
    if args.status != 'all':
        stmt = stmt.where(session.c.status == args.status)
    if args.session_ids:
        stmt = stmt.where(session.c.client_id.in_(args.session_ids))
    if args.plan_ids:
        stmt = stmt.where(session.c.original_plan_id.in_(args.plan_ids))
    workout = []
    if args.workout_ids:
        workout.append(session.c.original_workout_id.in_(args.workout_ids))
    if args.workout_names:
        workout.append(_name_match(session.c.name, args.workout_names))
    if workout:
        stmt = stmt.where(sa.or_(*workout))
    if args.exercise_ids or args.exercise_names:
        exercise = []
        if args.exercise_ids:
            exercise.append(block.c.original_exercise_id.in_(args.exercise_ids))
        if args.exercise_names:
            exercise.append(_name_match(block.c.name, args.exercise_names))
        stmt = stmt.where(sa.exists(sa.select(1).select_from(block).where(
            block.c.user_id == user_id, block.c.deleted_at.is_(None),
            block.c.session_pk == session.c.pk, sa.or_(*exercise))))
    if args.sort == 'nearest':
        order = [sa.func.abs(session.c.date - center), session.c.date.desc(), session.c.pk.desc()]
    elif args.sort == 'oldest':
        order = [session.c.date.asc(), session.c.pk.asc()]
    else:
        order = [session.c.date.desc(), session.c.pk.desc()]
    return stmt.order_by(*order), {'fromDate': start.isoformat() if start else None,
                                    'toDate': end.isoformat() if end else None,
                                    'centerDate': center.isoformat() if center else None}


def _fingerprint(args: BaseModel) -> str:
    payload = args.model_dump(mode='json', by_alias=True, exclude={'cursor'})
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()[:16]


def _offset(cursor: str | None, fingerprint: str) -> int:
    if cursor is None:
        return 0
    try:
        value = json.loads(base64.urlsafe_b64decode(cursor + '=' * (-len(cursor) % 4)))
        offset = value['offset']
        if value['fingerprint'] != fingerprint or type(offset) is not int or not 0 <= offset <= MAX_PAGE_OFFSET:
            raise ValueError
        return offset
    except (ValueError, KeyError, TypeError, binascii.Error, UnicodeDecodeError):
        raise ValueError('Invalid or mismatched cursor') from None


def _next_cursor(offset: int, fingerprint: str) -> str:
    payload = json.dumps({'offset': offset, 'fingerprint': fingerprint}, separators=(',', ':'))
    return base64.urlsafe_b64encode(payload.encode()).decode().rstrip('=')


async def _page(data: Store, stmt, args: BaseModel):
    fingerprint = _fingerprint(args)
    offset = _offset(args.cursor, fingerprint)
    rows = (await data.session.execute(stmt.limit(args.limit + 1).offset(offset))).mappings().all()
    has_more = len(rows) > args.limit
    return rows[:args.limit], (_next_cursor(offset + args.limit, fingerprint) if has_more else None)


async def _search_sessions(data: Store, args: SessionSearch, today: date):
    stmt, applied = _session_statement(args, data.user_id, today)
    rows, cursor = await _page(data, stmt, args)
    documents = await data.documents('sessions', rows)
    return {'items': [{
        'id': item['id'], 'date': item['date'], 'name': item['name'], 'status': item['status'],
        'planId': item['planId'], 'workoutId': item['workoutId'],
        'exercises': [{'id': block['exerciseId'], 'name': block['name']} for block in item['blocks']],
    } for item in documents], 'nextCursor': cursor, 'appliedDateRange': applied}


async def _details(data: Store, resource: str, args: RecordIds):
    table = tables.workout_sessions if resource == 'sessions' else tables.training_plans
    rows = await data.rows(table, table.c.client_id.in_(args.ids))
    documents = await data.documents(resource, rows)
    found = {item['id']: item for item in documents}
    return {'items': [found[item] for item in args.ids if item in found],
            'missingIds': [item for item in args.ids if item not in found]}


async def _exercise_history(data: Store, args: ExerciseHistory, today: date):
    stmt, applied = _session_statement(args, data.user_id, today)
    rows, cursor = await _page(data, stmt, args)
    documents = await data.documents('sessions', rows)
    profile = await data.root(tables.profiles, 'profile')
    preferred = profile['unit'] if profile else 'kg'
    items = []
    total_sets = 0
    for session in documents:
        blocks = []
        for block in session['blocks']:
            matches_id = block['exerciseId'] in args.exercise_ids
            matches_name = any(name.casefold() in block['name'].casefold() for name in args.exercise_names)
            if not (matches_id or matches_name):
                continue
            completed = [item for item in block['sets'] if item['done']]
            selected = block['sets'] if args.include_incomplete else completed
            total_sets += len(selected)
            if total_sets > 100:
                return {'error': 'Too many matching sets; narrow the date range or use a smaller page.'}
            best = max(completed, key=lambda item: ((item['kg'] or 0), item['reps'] or 0), default=None)
            volume = sum(item['kg'] * item['reps'] for item in completed if item['kg'] is not None and item['reps'] is not None)
            blocks.append({'exerciseId': block['exerciseId'], 'name': block['name'],
                           'loadMode': block['loadMode'], 'sets': selected,
                           'bestRecordedSet': best,
                           'volumeKg': volume if block['loadMode'] == 'external' else None})
        items.append({'sessionId': session['id'], 'date': session['date'], 'workoutName': session['name'],
                      'exercises': blocks})
    return {'items': items, 'preferredUnit': preferred, 'nextCursor': cursor,
            'appliedDateRange': applied, 'estimatedStrength': False}


async def _profile(data: Store):
    row = await data.root(tables.profiles, 'profile')
    return {'profile': (await data.documents('profile', [row]))[0] if row else None}


async def _search_plans(data: Store, args: PlanSearch):
    table = tables.training_plans
    stmt = sa.select(table).where(table.c.user_id == data.user_id, table.c.deleted_at.is_(None))
    choices = []
    if args.ids:
        choices.append(table.c.client_id.in_(args.ids))
    if args.names:
        choices.append(_name_match(table.c.name, args.names))
    if choices:
        stmt = stmt.where(sa.or_(*choices))
    if args.active is not None:
        stmt = stmt.where(table.c.active == args.active)
    rows, cursor = await _page(data, stmt.order_by(table.c.created_at.desc(), table.c.pk.desc()), args)
    workouts = await data.grouped(tables.planned_workouts, 'plan_pk', [row['pk'] for row in rows])
    return {'items': [{'id': row['client_id'], 'name': row['name'], 'active': row['active'],
                      'schedule': row['schedule'], 'revision': row['revision'],
                      'workouts': [{'id': item['client_id'], 'name': item['name']}
                                   for item in workouts[row['pk']]]} for row in rows],
            'nextCursor': cursor}


async def _search_exercises(data: Store, args: ExerciseSearch):
    # Apply the same bounded filters to owned definitions and the small shared catalog.
    def conditions(table):
        filters = []
        if args.custom is not None:
            filters.append(table.c.custom == args.custom)
        choices = []
        if args.ids:
            choices.append(table.c.client_id.in_(args.ids))
        if args.names:
            choices.append(_name_match(table.c.name, args.names))
        if choices:
            filters.append(sa.or_(*choices))
        return filters

    owned = await data.rows(tables.exercises, *conditions(tables.exercises))
    catalog = await data.rows(tables.exercise_catalog, *conditions(tables.exercise_catalog))
    by_id = {item['id']: item for item in await data.documents('catalog', catalog)}
    by_id.update({item['id']: item for item in await data.documents('exercises', owned)})
    items = list(by_id.values())
    items.sort(key=lambda item: (item['name'].casefold(), item['id']))
    fingerprint = _fingerprint(args)
    offset = _offset(args.cursor, fingerprint)
    page = items[offset:offset + args.limit]
    next_cursor = _next_cursor(offset + args.limit, fingerprint) if len(items) > offset + args.limit else None
    return {'items': page, 'nextCursor': next_cursor}


async def run_database_tool(name: str, arguments: str, database, user_id: UUID, today: date) -> str:
    """Validate model arguments, then execute one short read-only account transaction."""
    model = ARG_MODELS.get(name)
    if model is None:
        raise InferenceError(502, 'Coach requested an unsupported tool. Try again.')
    try:
        args = model.model_validate_json(arguments)
        if isinstance(args, SessionSearch):
            args.resolve(today)
    except (ValidationError, ValueError) as error:
        return json.dumps({'error': 'Invalid tool filters', 'details': str(error)[:600]})
    async with database.sessions() as session:
        async with session.begin():
            await session.execute(sa.text('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY'))
            await set_identity(session, user_id)
            data = Store(session, user_id)
            if name == 'search_workout_sessions':
                result = await _search_sessions(data, args, today)
            elif name == 'get_workout_sessions':
                result = await _details(data, 'sessions', args)
            elif name == 'get_exercise_history':
                result = await _exercise_history(data, args, today)
            elif name == 'get_training_profile':
                result = await _profile(data)
            elif name == 'search_training_plans':
                result = await _search_plans(data, args)
            elif name == 'get_training_plans':
                result = await _details(data, 'plans', args)
            else:
                result = await _search_exercises(data, args)
    output = json.dumps(jsonable_encoder(result), separators=(',', ':'), allow_nan=False)
    if len(output) > MAX_RESULT_CHARS:
        return json.dumps({'error': 'Result too large; narrow the filters or request fewer records.'})
    return output
