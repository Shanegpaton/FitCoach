"""Scripted model + real SQL validates the evaluation harness, not model quality."""
import copy
import json
from pathlib import Path

from evaluations import coach


async def test_evaluation_runner_reads_real_snapshots_and_constructs_a_pending_preview(api, monkeypatch):
    _, database, _, _ = api
    fixture = json.loads((Path(coach.__file__).parent / 'fixtures.json').read_text())
    corrected = copy.deepcopy(fixture['sessions'][0]); corrected['blocks'][0]['sets'][0]['reps'] = 10
    sequence = iter([
        {'output': [{'type': 'function_call', 'name': 'get_workout_sessions', 'call_id': 'read', 'arguments': json.dumps({'ids': ['session']})}]},
        {'output': [{'type': 'function_call', 'name': 'propose_workout_changes', 'call_id': 'preview', 'arguments': json.dumps({'sessionId': 'session', 'session': corrected})}]},
        {'output': [], 'text': 'Review the pending correction to 10 reps.'},
    ])
    async def scripted(*args, **kwargs):
        return next(sequence)
    monkeypatch.setattr(coach, 'complete_agent_turn', scripted)
    result = await coach.evaluate(database, 'not-a-real-token', None, {'id': 'scripted-correction', 'prompt': 'Correct it', 'proposal': 'session', 'reps': 10}, fixture, 1)
    assert result['automatedPassed'], result
    assert result['humanReview'] == 'pending'
