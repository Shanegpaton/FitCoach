"""Transactional aggregate mutations and ordered document assembly."""
from collections import defaultdict
from datetime import date, datetime, timezone
from decimal import Decimal
from uuid import UUID, uuid4

import sqlalchemy as sa
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

if __package__:
    from . import schema as s
    from .database import lock_user_mutations
    from .domain import Plan, Session
else:
    import schema as s
    from database import lock_user_mutations
    from domain import Plan, Session

RESOURCES = {'exercises': s.exercises, 'plans': s.training_plans,
             'sessions': s.workout_sessions, 'schedule-overrides': s.schedule_overrides,
             'profile': s.profiles, 'catalog': s.exercise_catalog}
SYNC_RESOURCES = {'profile': s.profiles, 'exercises': s.exercises, 'plans': s.training_plans,
                  'sessions': s.workout_sessions, 'schedule-overrides': s.schedule_overrides}
CHILDREN = {
    s.training_plans: [(s.planned_workouts, 'plan_pk'), (s.schedule_overrides, 'plan_pk')],
    s.planned_workouts: [(s.planned_workout_days, 'workout_pk'), (s.planned_exercises, 'workout_pk'),
                        (s.schedule_overrides, 'workout_pk')],
    s.planned_exercises: [(s.planned_sets, 'block_pk')],
    s.workout_sessions: [(s.workout_exercises, 'session_pk')],
    s.workout_exercises: [(s.workout_sets, 'block_pk')],
}


def etag(row):
    return f'"{row["version"]}"'


def require_match(row, value):
    if value is None:
        raise HTTPException(428, 'If-Match is required; read the resource ETag first')
    # Only a single strong version ETag is accepted; wildcard cannot protect stale writes.
    if value != etag(row):
        raise HTTPException(412, 'The resource changed; read it again')


def exercise_document(row):
    return dict(id=row['client_id'], name=row['name'], muscle=row['muscle'], equipment=row['equipment'],
                loadMode=row['load_mode'], custom=row['custom'])


def set_document(row, logged=False):
    result = dict(id=row['client_id'], kind=row['kind'], targetReps=row['target_reps'],
                  targetKg=row['target_kg'], chainId=row['chain_id'])
    if logged:
        result.update(kg=row['kg'], reps=row['reps'], effort=row['effort'], done=row['done'])
    return result


def set_values(item, logged=False):
    result = dict(kind=item.kind, target_reps=item.targetReps, target_kg=decimal_value(item.targetKg), chain_id=item.chainId)
    if logged:
        result.update(kg=decimal_value(item.kg), reps=item.reps, effort=decimal_value(item.effort), done=item.done)
    return result


def decimal_value(value):
    # Passing float8 parameters to PostgreSQL NUMERIC can round to 15 digits.
    # Send their decimal representation instead, retaining the JS/Python number.
    return Decimal(str(value)) if value is not None else None


def validate_aggregate(item):
    """Recheck aggregate invariants at the transaction boundary."""
    if isinstance(item, Plan):
        days = [day for workout in item.workouts for day in workout.days]
        if item.cursor >= len(item.workouts) or (item.schedule == 'week' and len(set(days)) != len(days)):
            raise HTTPException(422, 'Invalid plan schedule')
    if isinstance(item, Session):
        if item.status == 'completed' and item.completedAt is None:
            raise HTTPException(422, 'Completed sessions need a completion time')
        for block in item.blocks:
            for logged in block.sets:
                if logged.done and (logged.reps is None or (block.loadMode == 'external' and logged.kg is None)):
                    raise HTTPException(422, 'Completed sets need reps and any required external load')


class Store:
    def __init__(self, session: AsyncSession, user_id: UUID):
        self.session, self.user_id = session, user_id

    async def rows(self, table, *conditions, live=True, lock=False, order=None):
        statement = sa.select(table)
        if 'user_id' in table.c:
            statement = statement.where(table.c.user_id == self.user_id)
        if live and 'deleted_at' in table.c:
            statement = statement.where(table.c.deleted_at.is_(None))
        statement = statement.where(*conditions)
        if order is not None:
            statement = statement.order_by(*order)
        if lock:
            statement = statement.with_for_update()
        return (await self.session.execute(statement)).mappings().all()

    async def root(self, table, client_id, live=True, lock=False):
        rows = await self.rows(table, table.c.client_id == client_id, live=live, lock=lock)
        return rows[0] if rows else None

    async def read(self, resource, client_id):
        row = await self.root(RESOURCES[resource], client_id)
        if row is None:
            raise HTTPException(404, 'Resource not found')
        return (await self.documents(resource, [row]))[0], row

    async def list(self, resource, limit, offset):
        table = RESOURCES[resource]
        stmt = sa.select(table)
        if 'user_id' in table.c:
            stmt = stmt.where(table.c.user_id == self.user_id, table.c.deleted_at.is_(None))
            order = [table.c.created_at, table.c.pk]
        else:
            order = [table.c.client_id]
        if resource == 'sessions':
            order = [table.c.date.desc(), table.c.created_at.desc(), table.c.pk]
        rows = (await self.session.execute(stmt.order_by(*order).limit(limit).offset(offset))).mappings().all()
        return dict(items=await self.documents(resource, rows), limit=limit, offset=offset)

    async def insert(self, table, values):
        return (await self.session.execute(table.insert().values(user_id=self.user_id, **values)
                                           .returning(table))).mappings().one()

    async def update(self, table, pk, values):
        return (await self.session.execute(table.update().where(table.c.user_id == self.user_id, table.c.pk == pk)
                                          .values(**values).returning(table))).mappings().one()

    async def mark_sync_change(self, table, pk):
        """Advance this account's cursor and stamp the changed aggregate root atomically."""
        sequence = await self.session.scalar(sa.text('''
            INSERT INTO fitcoach.sync_state(user_id, sequence) VALUES (:user_id, 1)
            ON CONFLICT (user_id) DO UPDATE SET sequence = fitcoach.sync_state.sequence + 1
            RETURNING sequence
        '''), {'user_id': self.user_id})
        return await self.update(table, pk, {'sync_sequence': sequence})

    async def check_write(self, table, client_id, if_match, create_only=False):
        row = await self.root(table, client_id, live=False, lock=True)
        if row is not None and row['deleted_at'] is not None:
            raise HTTPException(404 if if_match is not None else 409, 'Deleted IDs cannot be reused')
        if row is not None:
            if create_only and row['deleted_at'] is None:
                raise HTTPException(409, 'Resource already exists')
            require_match(row, if_match)
        elif if_match is not None:
            raise HTTPException(404, 'Resource not found')
        return row

    async def save_root(self, table, client_id, values, row):
        if row is None:
            return await self.insert(table, dict(client_id=client_id, **values))
        return await self.update(table, row['pk'], values)

    async def tombstone(self, table, pks):
        if not pks:
            return
        for child, parent in CHILDREN.get(table, []):
            children = await self.rows(child, child.c[parent].in_(pks))
            await self.tombstone(child, [item['pk'] for item in children])
        for pk in pks:
            row = await self.rows(table, table.c.pk == pk, live=False)
            if not row or row[0]['deleted_at'] is not None:
                continue
            values = {'deleted_at': datetime.now(timezone.utc)}
            if table in s.SYNC_ROOTS:
                sequence = await self.session.scalar(sa.text('''
                    INSERT INTO fitcoach.sync_state(user_id, sequence) VALUES (:user_id, 1)
                    ON CONFLICT (user_id) DO UPDATE SET sequence = fitcoach.sync_state.sequence + 1
                    RETURNING sequence
                '''), {'user_id': self.user_id})
                values['sync_sequence'] = sequence
            await self.update(table, pk, values)

    async def reconcile(self, table, parent_column, parent_pk, entries):
        """Preserve identities, stage reordering, tombstone omissions; never resurrect."""
        old = await self.rows(table, table.c[parent_column] == parent_pk, live=False)
        existing = {row['client_id']: row for row in old}
        keep = {client_id for client_id, _ in entries}
        for client_id, _ in entries:
            if client_id in existing and existing[client_id]['deleted_at'] is not None:
                raise HTTPException(409, 'Removed child IDs cannot be reused')
        live = [row for row in old if row['deleted_at'] is None]
        shift = max((row['position'] for row in live), default=0) + len(entries) + 1
        if live:
            await self.session.execute(table.update().where(table.c.user_id == self.user_id,
                table.c[parent_column] == parent_pk, table.c.deleted_at.is_(None))
                .values(position=table.c.position + shift))
        await self.tombstone(table, [row['pk'] for row in live if row['client_id'] not in keep])
        result = []
        for position, (client_id, values) in enumerate(entries):
            fields = dict(position=position, **values)
            if client_id in existing:
                row = await self.update(table, existing[client_id]['pk'], fields)
            else:
                row = await self.insert(table, dict(client_id=client_id, **{parent_column: parent_pk}, **fields))
            result.append(row)
        return result

    async def exercise_reference(self, client_id, required=True):
        owned = await self.root(s.exercises, client_id, live=required)
        if owned:
            return owned['pk']
        # Never recycle an owned tombstone merely because its catalog default still exists.
        deleted = await self.root(s.exercises, client_id, live=False)
        if deleted:
            if required:
                raise HTTPException(422, 'Plan references a deleted exercise')
            return deleted['pk']
        catalog = await self.root(s.exercise_catalog, client_id)
        if catalog:
            row = await self.insert(s.exercises, dict(client_id=client_id, catalog_id=client_id,
                **{key: catalog[key] for key in ('name', 'muscle', 'equipment', 'load_mode', 'custom')}))
            await self.mark_sync_change(s.exercises, row['pk'])
            return row['pk']
        if required:
            raise HTTPException(422, 'Unknown exercise in plan')
        return None

    async def put(self, resource, item, if_match, create_only=False):
        await lock_user_mutations(self.session, self.user_id)
        validate_aggregate(item)
        table = RESOURCES[resource]
        old = await self.check_write(table, item.id, if_match, create_only)
        if resource == 'profile':
            values = dict(goals=item.goals, experience=item.experience, equipment=item.equipment,
                training_days=item.trainingDays, session_minutes=item.sessionMinutes, unit=item.unit,
                onboarding_done=item.onboardingDone)
        elif resource == 'exercises':
            catalog = await self.root(s.exercise_catalog, item.id)
            values = dict(name=item.name, muscle=item.muscle, equipment=item.equipment,
                load_mode=item.loadMode, custom=item.custom, catalog_id=item.id if catalog else None)
        elif resource == 'plans':
            if item.active:
                deactivated = (await self.session.execute(s.training_plans.update().where(
                    s.training_plans.c.user_id == self.user_id, s.training_plans.c.deleted_at.is_(None),
                    s.training_plans.c.active, s.training_plans.c.client_id != item.id).values(active=False)
                    .returning(s.training_plans.c.pk))).scalars().all()
                for pk in deactivated:
                    await self.mark_sync_change(s.training_plans, pk)
            values = dict(name=item.name, schedule=item.schedule, cursor=item.cursor,
                          revision=item.revision, active=item.active)
        elif resource == 'sessions':
            plan = await self.root(s.training_plans, item.planId, live=False)
            source = await self.rows(s.planned_workouts, s.planned_workouts.c.plan_pk == plan['pk'],
                                    s.planned_workouts.c.client_id == item.workoutId, live=False) if plan else []
            values = dict(original_plan_id=item.planId, original_workout_id=item.workoutId,
                source_workout_pk=source[0]['pk'] if source else None, name=item.name,
                date=date.fromisoformat(item.date), started_at=item.startedAt, completed_at=item.completedAt,
                status=item.status, notes=item.notes, timer_present=item.timer is not None,
                timer_end_at=decimal_value(item.timer.endAt) if item.timer else None,
                timer_remaining=decimal_value(item.timer.remaining) if item.timer else None,
                timer_duration=item.timer.duration if item.timer else None)
        elif resource == 'schedule-overrides':
            plan = await self.root(s.training_plans, item.planId, lock=True)
            workouts = await self.rows(s.planned_workouts, s.planned_workouts.c.plan_pk == plan['pk'],
                s.planned_workouts.c.client_id == item.workoutId) if plan else []
            if not workouts:
                raise HTTPException(422, 'Schedule override references a missing workout')
            values = dict(plan_pk=plan['pk'], workout_pk=workouts[0]['pk'],
                          original_date=date.fromisoformat(item.originalDate), date=date.fromisoformat(item.date))
        else:
            raise ValueError('Read-only resource')
        row = await self.save_root(table, item.id, values, old)
        if resource == 'plans':
            workouts = await self.reconcile(s.planned_workouts, 'plan_pk', row['pk'],
                                           [(workout.id, dict(name=workout.name)) for workout in item.workouts])
            for workout, stored in zip(item.workouts, workouts):
                prior_days = await self.rows(s.planned_workout_days,
                    s.planned_workout_days.c.workout_pk == stored['pk'], order=[s.planned_workout_days.c.position])
                by_day = defaultdict(list)
                for day_row in prior_days:
                    by_day[day_row['day']].append(day_row['client_id'])
                entries = [(by_day[day].pop(0) if by_day[day] else str(uuid4()), dict(day=day)) for day in workout.days]
                await self.reconcile(s.planned_workout_days, 'workout_pk', stored['pk'], entries)
                entries = []
                for block in workout.blocks:
                    entries.append((block.id, dict(exercise_pk=await self.exercise_reference(block.exerciseId),
                                      rest_seconds=block.restSeconds, superset_id=block.supersetId)))
                blocks = await self.reconcile(s.planned_exercises, 'workout_pk', stored['pk'], entries)
                for block, block_row in zip(workout.blocks, blocks):
                    await self.reconcile(s.planned_sets, 'block_pk', block_row['pk'],
                                        [(x.id, set_values(x)) for x in block.sets])
        if resource == 'sessions':
            entries = []
            for block in item.blocks:
                entries.append((block.id, dict(original_exercise_id=block.exerciseId,
                    exercise_pk=await self.exercise_reference(block.exerciseId, required=False),
                    name=block.name, load_mode=block.loadMode, rest_seconds=block.restSeconds,
                    superset_id=block.supersetId, notes=block.notes)))
            blocks = await self.reconcile(s.workout_exercises, 'session_pk', row['pk'], entries)
            for block, stored in zip(item.blocks, blocks):
                await self.reconcile(s.workout_sets, 'block_pk', stored['pk'],
                                    [(x.id, set_values(x, logged=True)) for x in block.sets])
        row = await self.mark_sync_change(table, row['pk'])
        return (await self.documents(resource, [row]))[0], row, old is None

    async def delete(self, resource, client_id, if_match):
        await lock_user_mutations(self.session, self.user_id)
        table = RESOURCES[resource]
        row = await self.root(table, client_id, lock=True)
        if row is None:
            raise HTTPException(404, 'Resource not found')
        require_match(row, if_match)
        await self.tombstone(table, [row['pk']])

    async def changes(self, cursor, limit):
        high_water = await self.session.scalar(sa.select(s.sync_state.c.sequence)
            .where(s.sync_state.c.user_id == self.user_id)) or 0
        high_water = int(high_water)
        if cursor > high_water:
            raise HTTPException(409, 'Sync cursor is ahead of this account; reset synchronization state')
        streams = [sa.select(table.c.sync_sequence.label('sequence'), sa.literal(resource).label('resource'),
            table.c.client_id.label('id'), table.c.deleted_at.label('deleted_at'),
            table.c.version.label('version')).where(table.c.user_id == self.user_id,
            table.c.sync_sequence > cursor, table.c.sync_sequence <= high_water)
            for resource, table in SYNC_RESOURCES.items()]
        changed = sa.union_all(*streams).subquery()
        rows = (await self.session.execute(sa.select(changed).order_by(changed.c.sequence,
            changed.c.resource, changed.c.id).limit(limit + 1))).mappings().all()
        has_more = len(rows) > limit
        rows = rows[:limit]
        records = []
        for item in rows:
            document = None
            if item['deleted_at'] is None:
                table = SYNC_RESOURCES[item['resource']]
                root = await self.root(table, item['id'])
                if root is not None:
                    document = (await self.documents(item['resource'], [root]))[0]
            records.append(dict(resource=item['resource'], id=item['id'], sequence=int(item['sequence']),
                version=int(item['version']), etag=etag(item), deleted=item['deleted_at'] is not None,
                document=document))
        next_cursor = int(rows[-1]['sequence']) if has_more and rows else high_water
        return dict(items=records, cursor=next_cursor, highWater=high_water, hasMore=has_more)

    async def sync_record(self, resource, client_id):
        if resource not in SYNC_RESOURCES:
            raise HTTPException(404, 'Resource not found')
        table = SYNC_RESOURCES[resource]
        row = await self.root(table, client_id, live=False)
        if row is None:
            return dict(resource=resource, id=client_id, sequence=0, version=0,
                etag=None, deleted=True, document=None)
        document = None if row['deleted_at'] is not None else (await self.documents(resource, [row]))[0]
        return dict(resource=resource, id=client_id, sequence=int(row['sync_sequence']),
            version=int(row['version']), etag=etag(row), deleted=row['deleted_at'] is not None,
            document=document)

    async def grouped(self, table, parent, pks):
        result = defaultdict(list)
        if pks:
            for row in await self.rows(table, table.c[parent].in_(pks), order=[table.c.position]):
                result[row[parent]].append(row)
        return result

    async def documents(self, resource, rows):
        if not rows:
            return []
        if resource in ('exercises', 'catalog'):
            return [exercise_document(row) for row in rows]
        if resource == 'profile':
            return [dict(id='profile', goals=r['goals'], experience=r['experience'], equipment=r['equipment'],
                trainingDays=r['training_days'], sessionMinutes=r['session_minutes'], unit=r['unit'],
                onboardingDone=r['onboarding_done']) for r in rows]
        if resource == 'schedule-overrides':
            plans = {r['pk']: r['client_id'] for r in await self.rows(s.training_plans,
                s.training_plans.c.pk.in_([r['plan_pk'] for r in rows]), live=False)}
            workouts = {r['pk']: r['client_id'] for r in await self.rows(s.planned_workouts,
                s.planned_workouts.c.pk.in_([r['workout_pk'] for r in rows]), live=False)}
            return [dict(id=r['client_id'], planId=plans[r['plan_pk']], workoutId=workouts[r['workout_pk']],
                         originalDate=r['original_date'].isoformat(), date=r['date'].isoformat()) for r in rows]
        if resource == 'plans':
            workouts = await self.grouped(s.planned_workouts, 'plan_pk', [r['pk'] for r in rows])
            all_workouts = [w for group in workouts.values() for w in group]
            days = await self.grouped(s.planned_workout_days, 'workout_pk', [w['pk'] for w in all_workouts])
            blocks = await self.grouped(s.planned_exercises, 'workout_pk', [w['pk'] for w in all_workouts])
            all_blocks = [b for group in blocks.values() for b in group]
            sets = await self.grouped(s.planned_sets, 'block_pk', [b['pk'] for b in all_blocks])
            exercises = {r['pk']: r['client_id'] for r in await self.rows(s.exercises,
                s.exercises.c.pk.in_([b['exercise_pk'] for b in all_blocks]), live=False)}
            return [dict(id=r['client_id'], name=r['name'], schedule=r['schedule'], cursor=r['cursor'],
                revision=r['revision'], active=r['active'], workouts=[dict(id=w['client_id'], name=w['name'],
                    days=[d['day'] for d in days[w['pk']]], blocks=[dict(id=b['client_id'],
                        exerciseId=exercises[b['exercise_pk']], restSeconds=b['rest_seconds'],
                        supersetId=b['superset_id'], sets=[set_document(x) for x in sets[b['pk']]])
                        for b in blocks[w['pk']]]) for w in workouts[r['pk']]]) for r in rows]
        if resource == 'sessions':
            blocks = await self.grouped(s.workout_exercises, 'session_pk', [r['pk'] for r in rows])
            sets = await self.grouped(s.workout_sets, 'block_pk', [b['pk'] for group in blocks.values() for b in group])
            return [dict(id=r['client_id'], planId=r['original_plan_id'], workoutId=r['original_workout_id'],
                name=r['name'], date=r['date'].isoformat(), startedAt=r['started_at'], completedAt=r['completed_at'],
                status=r['status'], notes=r['notes'], timer=dict(endAt=r['timer_end_at'], remaining=r['timer_remaining'],
                    duration=r['timer_duration']) if r['timer_present'] else None,
                blocks=[dict(id=b['client_id'], exerciseId=b['original_exercise_id'], name=b['name'],
                    loadMode=b['load_mode'], restSeconds=b['rest_seconds'], supersetId=b['superset_id'],
                    notes=b['notes'], sets=[set_document(x, logged=True) for x in sets[b['pk']]])
                    for b in blocks[r['pk']]]) for r in rows]
        raise ValueError('Unknown resource')
