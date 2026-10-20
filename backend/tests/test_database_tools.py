import json
from datetime import date
from uuid import uuid4

import pytest
from pydantic import ValidationError
from sqlalchemy.dialects import postgresql

from backend.agent.inference import InferenceError
from backend.agent.tools.database import (
    ARG_MODELS, SessionSearch, TOOL_SPECS, _fingerprint, _next_cursor, _offset,
    _session_statement, run_database_tool,
)


def session_filters(**overrides):
    values = dict(fromDate=None, toDate=None, relativeMode=None, relativeUnit=None,
                  relativeAmount=None, windowDays=None, sessionIds=[], planIds=[],
                  workoutIds=[], workoutNames=[], exerciseIds=[], exerciseNames=[],
                  status='completed', sort='newest', limit=10, cursor=None)
    return {**values, **overrides}


def test_year_ago_nearest_window_and_calendar_month():
    year = SessionSearch.model_validate(session_filters(relativeMode='around',
        relativeUnit='years', relativeAmount=1, sort='nearest'))
    assert year.resolve(date(2026, 10, 20)) == (date(2025, 9, 5), date(2025, 12, 4), date(2025, 10, 20))
    month = SessionSearch.model_validate(session_filters(relativeMode='around',
        relativeUnit='months', relativeAmount=1))
    assert month.resolve(date(2024, 3, 31))[2] == date(2024, 2, 29)


@pytest.mark.parametrize('changes', [
    {'sort': 'nearest'}, {'relativeMode': 'past', 'relativeUnit': 'days'},
    {'fromDate': '2025-01-03', 'toDate': '2025-01-01'},
    {'workoutNames': ['']}, {'limit': 100}, {'cursor': 123},
    {'relativeMode': 'around', 'relativeUnit': 'years', 'relativeAmount': 1, 'fromDate': '2025-01-01'},
])
def test_invalid_filters_are_rejected(changes):
    with pytest.raises(ValidationError):
        SessionSearch.model_validate_json(json.dumps(session_filters(**changes)))


def test_tool_specs_are_closed_and_have_matching_models():
    assert {item['name'] for item in TOOL_SPECS} == set(ARG_MODELS)
    for item in TOOL_SPECS:
        params = item['parameters']
        assert item['strict'] is True
        assert params['additionalProperties'] is False
        assert set(params['properties']) == set(params['required'])


def test_cursor_is_bound_to_filters():
    args = SessionSearch.model_validate(session_filters())
    cursor = _next_cursor(10, _fingerprint(args))
    assert _offset(cursor, _fingerprint(args)) == 10
    changed = SessionSearch.model_validate(session_filters(status='active'))
    with pytest.raises(ValueError):
        _offset(cursor, _fingerprint(changed))
    with pytest.raises(ValueError):
        _offset('!!', _fingerprint(args))


def test_session_query_scopes_user_and_escapes_name_patterns():
    user = uuid4()
    args = SessionSearch.model_validate(session_filters(exerciseNames=['bench_100%']))
    stmt, _ = _session_statement(args, user, date(2026, 10, 20))
    sql = str(stmt.compile(dialect=postgresql.dialect(), compile_kwargs={'literal_binds': True}))
    assert str(user) in sql
    assert 'workout_sessions.user_id' in sql
    assert 'workout_exercises.user_id' in sql
    assert any(value == '%bench\\_100\\%%' for value in stmt.compile().params.values())


@pytest.mark.asyncio
async def test_bad_or_unknown_tool_does_not_open_database():
    class NoDatabase:
        def sessions(self):
            raise AssertionError('Invalid tool must not access database')

    output = await run_database_tool('search_workout_sessions', '{}', NoDatabase(), uuid4(), date.today())
    assert json.loads(output)['error'] == 'Invalid tool filters'
    with pytest.raises(InferenceError):
        await run_database_tool('send_sql', '{}', NoDatabase(), uuid4(), date.today())
