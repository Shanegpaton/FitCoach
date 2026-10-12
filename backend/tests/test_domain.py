import importlib.util
import re
import sys
from pathlib import Path

import httpx
import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from backend.auth import AuthVerifier
from backend.config import validate_url
from backend.domain import Plan, Session
from backend.tests.fixtures import plan, session


@pytest.mark.parametrize('mutate', [
    lambda p: p.update(cursor=2),
    lambda p: p['workouts'].append(p['workouts'][0]),
    lambda p: p['workouts'][0]['blocks'].append(p['workouts'][0]['blocks'][0]),
    lambda p: p['workouts'][0]['blocks'][0]['sets'].append(p['workouts'][0]['blocks'][0]['sets'][0]),
    lambda p: p['workouts'][0]['blocks'][0]['sets'][0].update(targetKg=float('nan')),
    lambda p: p['workouts'][0]['blocks'][0]['sets'][0].update(targetKg=float('inf')),
    lambda p: p['workouts'][0]['blocks'][0]['sets'][0].update(targetReps=True),
    lambda p: p['workouts'][0]['blocks'][0]['sets'][0].update(targetKg=True),
    lambda p: p['workouts'][0]['blocks'][0]['sets'][0].update(targetKg='20'),
    lambda p: p['workouts'][0]['blocks'][0].update(restSeconds=-1),
])
def test_invalid_plan_rejected(mutate):
    document = plan()
    mutate(document)
    with pytest.raises(ValidationError):
        Plan.model_validate(document)


@pytest.mark.parametrize('mutate', [
    lambda s: s.update(completedAt=None),
    lambda s: s.update(date='2026-02-30'),
    lambda s: s.update(startedAt='2026-10-11T13:00:00'),
    lambda s: s['blocks'][0]['sets'][0].update(reps=None),
    lambda s: s['blocks'][0]['sets'][0].update(kg=None),
    lambda s: s['blocks'][0]['sets'][0].update(effort=11),
    lambda s: s['timer'].update(remaining=float('inf')),
])
def test_invalid_session_rejected(mutate):
    document = session()
    mutate(document)
    with pytest.raises(ValidationError):
        Session.model_validate(document)


def test_historical_unknown_values_and_timestamp_precision_are_preserved():
    document = session()
    document['blocks'][0]['loadMode'] = 'bodyweight'
    document['blocks'][0]['sets'][0]['kg'] = None
    assert Session.model_validate(document).model_dump() == document


def test_tls_and_driver_configuration():
    for url in ['sqlite:///api.db', 'postgresql+psycopg://u:p@db.example/db',
                'postgresql+psycopg://u:p@db.example/db?sslmode=disable']:
        with pytest.raises(ValueError):
            validate_url(url, allow_local_plaintext=True)
    assert validate_url('postgresql+psycopg://u:p@localhost/db', True)
    assert validate_url('postgresql+psycopg://u:p@db.example/db?sslmode=require')


def test_backend_is_independent_of_rag():
    assert 'fitcoach' not in sys.modules
    assert 'sentence_transformers' not in sys.modules
    assert 'torch' not in sys.modules


def test_frozen_migration_seed_matches_frontend_catalog():
    root = Path(__file__).parents[2]
    specification = importlib.util.spec_from_file_location('seed', root / 'backend/migrations/versions/0001_relational_training.py')
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    definitions = re.findall(r"\['([^']+)', '([^']+)', '([^']+)', '([^']+)'\]", (root / 'frontend/src/catalog.ts').read_text())
    assert definitions == module.CATALOG


@pytest.mark.parametrize('kind', ['network', 'malformed', 'wrong-id', 'rate-limit', 'invalid'])
async def test_auth_errors(kind):
    def response(request):
        if kind == 'network':
            raise httpx.ConnectError('offline', request=request)
        if kind == 'malformed':
            return httpx.Response(200, text='invalid json')
        if kind == 'wrong-id':
            return httpx.Response(200, json={'id': 'not-a-uuid'})
        return httpx.Response(429 if kind == 'rate-limit' else 401)
    async with httpx.AsyncClient(transport=httpx.MockTransport(response)) as client:
        verifier = AuthVerifier(client, 'https://auth.example', 'key')
        with pytest.raises(HTTPException) as error:
            await verifier.verify('token')
        assert error.value.status_code == (401 if kind == 'invalid' else 503)
