def profile():
    return dict(id='profile', goals='Stronger', experience='Beginner', equipment=['Full gym', 'Dumbbells'],
                trainingDays=[5, 1, 3], sessionMinutes=45, unit='lb', onboardingDone=True)


def exercise(id='custom'):
    return dict(id=id, name='My exercise', muscle='Back', equipment='Dumbbell', loadMode='external', custom=True)


def plan(id='plan', active=False):
    return dict(id=id, name='Routine', schedule='week', cursor=0, revision=7, active=active, workouts=[
        dict(id='workout-a', name='Workout A', days=[5, 1], blocks=[dict(id='block-a', exerciseId='ex-squat',
            restSeconds=90, supersetId='super', sets=[
                dict(id='set-a', kind='working', targetReps=8, targetKg=None, chainId='chain'),
                dict(id='set-b', kind='drop', targetReps=10, targetKg=27.215542200000003, chainId='chain')])]),
        dict(id='workout-b', name='Workout B', days=[3], blocks=[dict(id='block-a', exerciseId='ex-pushup',
            restSeconds=0, supersetId=None, sets=[dict(id='set-a', kind='warmup', targetReps=5,
                targetKg=None, chainId=None)])])])


def session(id='session', status='completed'):
    return dict(id=id, planId='plan', workoutId='workout-a', name='Workout A snapshot', date='2026-10-11',
        startedAt='2026-10-11T13:00:00.000Z', completedAt='2026-10-11T14:00:00.1234567Z' if status == 'completed' else None,
        status=status, notes='A historical workout', timer=dict(endAt=1791720075123, remaining=0, duration=90),
        blocks=[dict(id='block-a', exerciseId='ex-squat', name='Barbell squat snapshot', loadMode='external',
            restSeconds=90, supersetId='super', notes='Snapshot notes', sets=[
                dict(id='set-a', kind='working', targetReps=8, targetKg=None, chainId='chain',
                    kg=27.215542200000003, reps=8, effort=7.500000000000001, done=True),
                dict(id='set-b', kind='drop', targetReps=10, targetKg=None, chainId='chain',
                    kg=None, reps=None, effort=None, done=False)])])


def override(id='override'):
    return dict(id=id, planId='plan', workoutId='workout-a', originalDate='2026-10-11', date='2026-10-12')


def headers(user='a', etag=None):
    result = {'Authorization': f'Bearer {user}'}
    if etag is not None:
        result['If-Match'] = etag
    return result
