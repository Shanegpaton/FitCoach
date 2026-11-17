"""These test the grader; they are not measurements of any model's quality."""
import copy
import json
from pathlib import Path

from evaluations.coach import grade

ROOT = Path(__file__).parent
FIXTURE = json.loads((ROOT / 'fixtures.json').read_text())


def test_fabricated_correct_and_incorrect_history_answers_are_distinguished():
    case = {'contains': ['60', '8'], 'tools': ['get_workout_sessions']}
    calls = [{'name': 'get_workout_sessions'}]
    assert all(grade(case, {'text': 'You logged 60 kg for 8 reps.'}, calls, FIXTURE, True).values())
    assert not all(grade(case, {'text': 'You logged 90 kg for 5 reps.'}, calls, FIXTURE, True).values())
    assert not grade(case, {'text': '60 kg, 8 reps'}, [], FIXTURE, True)['required_tools']


def test_workout_correction_must_preserve_other_fields_and_require_approval():
    case = {'proposal': 'session', 'reps': 10}
    corrected = copy.deepcopy(FIXTURE['sessions'][0])
    corrected['blocks'][0]['sets'][0]['reps'] = 10
    result = {'text': 'Review this preview.', 'proposal': {'status': 'pending', 'session': corrected}}
    assert all(grade(case, result, [], FIXTURE, True).values())
    corrected['blocks'][0]['sets'][0]['kg'] = 90
    assert not grade(case, result, [], FIXTURE, True)['only_requested_set_changed']
    assert not grade(case, result, [], FIXTURE, False)['training_records_unchanged']


def test_invalid_or_missing_plan_never_passes_constraints():
    case = {'proposal': 'plan', 'workouts': 3, 'maxMinutes': 30}
    result = {'text': 'Saved!', 'proposal': {'status': 'approved', 'plan': {}}}
    scores = grade(case, result, [], FIXTURE, True)
    assert not scores['pending_proposal'] and not scores['valid_plan']


def test_scenarios_have_unique_ids_and_patterns_compile():
    import re
    cases = json.loads((ROOT / 'scenarios.json').read_text())
    assert len(cases) == len({case['id'] for case in cases}) == 16
    for case in cases:
        for pattern in case.get('contains', []) + case.get('absent', []):
            re.compile(pattern)
