"""Run real Coach orchestration with synthetic PostgreSQL records; grade objective checks.

Live inference is explicitly opt-in and consumes connected model usage. Scorer
unit tests use fabricated results and never represent model-quality evidence.
"""
import argparse
import asyncio
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time
from uuid import uuid4
from datetime import date, datetime, timezone

from backend.domain import Profile, Plan, Session
from backend.database import Database, set_identity
from backend.config import Settings
from backend.store import Store
from backend.agent.graph import build_coach_graph
from backend.agent.inference import complete_agent_turn, resolve_model, agent_instructions
from backend.agent.tools.database import TOOL_SPECS, run_database_tool

ROOT = Path(__file__).parent


def grade(case, result, calls, original, unchanged):
    text = result.get('text', '')
    names = [call['name'] for call in calls]
    checks = {'nonempty_reply': bool(text.strip()), 'training_records_unchanged': unchanged}
    for pattern in case.get('contains', []):
        checks[f'contains:{pattern}'] = bool(re.search(pattern, text, re.I))
    for pattern in case.get('absent', []):
        checks[f'absent:{pattern}'] = not bool(re.search(pattern, text, re.I))
    if case.get('noTools'):
        checks['no_tools'] = not calls
    if case.get('tools'):
        expected = set(case['tools'])
        checks['required_tools'] = bool(expected.intersection(names)) if case.get('anyTool') else expected.issubset(names)
    proposal = result.get('proposal') or {}
    if case.get('proposal'):
        checks['pending_proposal'] = proposal.get('status') == 'pending'
        if case['proposal'] == 'plan':
            candidate = proposal.get('plan', {})
            try:
                plan = Plan.model_validate(candidate)
                checks['valid_plan'] = True
                checks['workout_count'] = len(plan.workouts) == case['workouts']
                checks['duration_targets'] = all(w.durationMinutes is not None and w.durationMinutes <= case['maxMinutes'] for w in plan.workouts)
                allowed = {'ex-row', 'ex-press', 'ex-curl', 'ex-lateral'}
                checks['dumbbell_only'] = all(b.exerciseId in allowed for w in plan.workouts for b in w.blocks)
            except (ValueError, TypeError):
                checks['valid_plan'] = False
        elif case['proposal'] == 'session':
            expected = copy.deepcopy(original['sessions'][0]); expected['blocks'][0]['sets'][0]['reps'] = case['reps']
            checks['only_requested_set_changed'] = proposal.get('session') == expected
        elif case['proposal'] == 'start':
            checks['active_session_preview'] = proposal.get('type') == 'session_create' and proposal.get('session', {}).get('status') == 'active'
    return checks


async def seed(database, user, fixture):
    async with database.sessions() as connection, connection.begin():
        await set_identity(connection, user)
        store = Store(connection, user)
        await store.put('profile', Profile.model_validate(fixture['profile']), None)
        await store.put('plans', Plan.model_validate(fixture['plan']), None)
        for item in fixture['sessions']:
            await store.put('sessions', Session.model_validate(item), None)


async def snapshot(database, user, fixture):
    async with database.sessions() as connection, connection.begin():
        await set_identity(connection, user)
        store = Store(connection, user)
        return {resource: await store.list(resource, 100, 0) for resource in ('profile', 'plans', 'sessions')}


async def evaluate(database, token, budget, case, fixture, repetition):
    user = uuid4()
    fixture = copy.deepcopy(fixture)
    if case.get('notes'):
        fixture['sessions'][0]['notes'] = case['notes']
    await seed(database, user, fixture)
    before = await snapshot(database, user, fixture)
    calls = []
    ready = case.get('ready', True)
    async def respond(items):
        return await complete_agent_turn(token, items, TOOL_SPECS if ready else [], ready, budget=budget)
    async def tool(name, arguments):
        if not ready:
            raise ValueError('Tools unavailable while training data is unsynchronized')
        calls.append({'name': name, 'arguments': json.loads(arguments)})
        return await run_database_tool(name, arguments, database, user, date(2026, 10, 12))
    started = time.monotonic()
    error_type = None
    try:
        async with asyncio.timeout(240):
            result = await build_coach_graph(respond, tool).ainvoke({'input': [*case.get('history', []), {'role': 'user', 'content': case['prompt']}]})
    except Exception as error:
        # Do not write provider errors or credentials into reports.
        result = {'text': ''}; error_type = type(error).__name__
    unchanged = before == await snapshot(database, user, fixture)
    checks = grade(case, result, calls, fixture, unchanged)
    return {'id': case['id'], 'repetition': repetition, 'durationSeconds': round(time.monotonic() - started, 3),
            'toolCalls': calls, 'text': result.get('text', ''), 'proposal': result.get('proposal'),
            'checks': checks, 'automatedPassed': all(checks.values()) and error_type is None,
            'errorType': error_type, 'humanReview': 'pending'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--live', action='store_true', help='Required: consumes connected ChatGPT usage')
    parser.add_argument('--model', required=True, help='Exact available account model ID; never silently substituted')
    parser.add_argument('--token-env', default='FITCOACH_EVAL_ACCESS_TOKEN')
    parser.add_argument('--repetitions', type=int, default=1)
    parser.add_argument('--output', type=Path, default=ROOT / 'results' / 'coach.json')
    parser.add_argument('--scenario', help='Run just one scenario ID')
    args = parser.parse_args()
    if not args.live or not 1 <= args.repetitions <= 10:
        parser.error('--live and 1–10 repetitions are required')
    token = os.getenv(args.token_env)
    if not token:
        parser.error(f'Set {args.token_env} outside source control; no credential is stored by this runner')
    from backend.testing.server import disposable_urls
    from alembic.config import Config
    from alembic import command
    admin, runtime = disposable_urls()
    os.environ['FITCOACH_MIGRATION_DATABASE_URL'] = admin
    os.environ['FITCOACH_ALLOW_LOCAL_PLAINTEXT'] = 'true'
    command.upgrade(Config(str(ROOT.parent / 'backend' / 'alembic.ini')), 'head')
    cases = json.loads((ROOT / 'scenarios.json').read_text())
    if args.scenario:
        cases = [case for case in cases if case['id'] == args.scenario]
        if not cases:
            parser.error('Unknown scenario ID')
    fixture = json.loads((ROOT / 'fixtures.json').read_text())
    async def run():
        database = Database(Settings(database_url=runtime, supabase_url='https://auth.example', supabase_key='test-only', allow_local_plaintext=True))
        try:
            await database.verify_runtime_role()
            budget = await resolve_model(token, args.model)
            records = []
            for repetition in range(1, args.repetitions + 1):
                for case in cases:
                    record = await evaluate(database, token, budget, case, fixture, repetition)
                    records.append(record)
                    print(f"{case['id']} [{repetition}]: {'pass' if record['automatedPassed'] else 'review'}")
            return records
        finally:
            await database.close()
    records = asyncio.run(run())
    report = {'schemaVersion': 1, 'kind': 'live-model-evaluation', 'model': args.model,
              'measuredAt': datetime.now(timezone.utc).isoformat(),
              'commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
              'workingTreeDirty': bool(subprocess.check_output(['git', 'status', '--porcelain'], text=True).strip()),
              'scenarioHash': hashlib.sha256((ROOT / 'scenarios.json').read_bytes()).hexdigest(),
              'instructionsHash': hashlib.sha256(agent_instructions().encode()).hexdigest(),
              'fixtureHash': hashlib.sha256((ROOT / 'fixtures.json').read_bytes()).hexdigest(),
              'toolsHash': hashlib.sha256(json.dumps(TOOL_SPECS, sort_keys=True).encode()).hexdigest(),
              'scope': 'Production agent, inference and SQL tools with synthetic account records. Does not exercise HTTP auth, persisted conversation recovery or automatic memory extraction. Regex checks require human review.',
              'automatedPassRate': sum(item['automatedPassed'] for item in records) / len(records),
              'results': records}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2, default=str) + '\n')
    print(f'Report: {args.output}. Review factual accuracy, personalization and safety before interpreting results.')
    raise SystemExit(0 if all(item['automatedPassed'] for item in records) else 1)


if __name__ == '__main__':
    main()
