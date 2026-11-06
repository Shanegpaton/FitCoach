"""Account-scoped Coach conversation records and bounded message history."""
import asyncio
from contextlib import asynccontextmanager
from contextvars import ContextVar
from datetime import datetime
import json
from uuid import UUID, uuid4

import sqlalchemy as sa
from fastapi import HTTPException

try:
    from .database import set_identity, lock_user_mutations
except ImportError:
    from database import set_identity, lock_user_mutations

PAGE_MAX = 100
CONTEXT_MESSAGES = 24
LEASE_SECONDS = 90
HEARTBEAT_SECONDS = 20
EXECUTION_SECONDS = 240
# Proposal inserts use the same transaction lock and ownership check as replies.
current_attempt = ContextVar('coach_attempt', default=None)


async def expire_turns(session, user_id, conversation_id):
    await session.execute(sa.text("""UPDATE fitcoach.coach_turns SET status='failed'
        WHERE user_id=:user AND conversation_id=:conversation AND status='started'
        AND (lease_expires_at IS NULL OR lease_expires_at <= clock_timestamp())"""),
        {'user': user_id, 'conversation': conversation_id})


async def assert_attempt(session, user_id, conversation_id, request_id, attempt_id):
    await lock_user_mutations(session, user_id)
    owned = await session.scalar(sa.text("""SELECT 1 FROM fitcoach.coach_turns
        WHERE user_id=:user AND conversation_id=:conversation AND request_id=:request
        AND status='started' AND attempt_id=:attempt AND lease_expires_at > clock_timestamp()
        FOR UPDATE"""), {'user': user_id, 'conversation': conversation_id,
                          'request': request_id, 'attempt': attempt_id})
    if not owned:
        raise HTTPException(409, 'This Coach attempt expired or was replaced. Check the conversation before retrying.')


async def guard_proposal(session, user_id):
    attempt = current_attempt.get()
    if attempt:
        await assert_attempt(session, user_id, *attempt)


async def renew_turn(database, user_id, conversation_id, request_id, attempt_id):
    async with database.sessions() as session:
        async with session.begin():
            await set_identity(session, user_id)
            await assert_attempt(session, user_id, conversation_id, request_id, attempt_id)
            await session.execute(sa.text("""UPDATE fitcoach.coach_turns
                SET lease_expires_at=clock_timestamp() + make_interval(secs => :seconds)
                WHERE user_id=:user AND conversation_id=:conversation AND request_id=:request
                AND attempt_id=:attempt"""), {'seconds': LEASE_SECONDS, 'user': user_id,
                    'conversation': conversation_id, 'request': request_id, 'attempt': attempt_id})


@asynccontextmanager
async def processing_turn(database, user_id, conversation_id, request_id, attempt_id):
    """Bound execution and cancel work if lease renewal fails. Hard kills recover by expiry."""
    owner = asyncio.current_task()
    heartbeat_error = []

    async def heartbeat():
        try:
            while True:
                await asyncio.sleep(HEARTBEAT_SECONDS)
                await renew_turn(database, user_id, conversation_id, request_id, attempt_id)
        except Exception as error:
            heartbeat_error.append(error)
            owner.cancel()

    timed_out = False

    def deadline():
        nonlocal timed_out
        timed_out = True
        owner.cancel()

    timer = asyncio.get_running_loop().call_later(EXECUTION_SECONDS, deadline)
    token = current_attempt.set((conversation_id, request_id, attempt_id))
    task = asyncio.create_task(heartbeat())
    try:
        yield
    except asyncio.CancelledError:
        if heartbeat_error:
            raise heartbeat_error[0]
        if timed_out:
            raise asyncio.TimeoutError() from None
        raise
    finally:
        timer.cancel()
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        current_attempt.reset(token)



def _conversation(row):
    return {'id': str(row['conversation_id']), 'title': row['title'],
            'createdAt': row['created_at'].isoformat(), 'updatedAt': row['updated_at'].isoformat()}


async def create_conversation(database, user_id: UUID):
    conversation_id = uuid4()
    async with database.sessions() as session:
        async with session.begin():
            await set_identity(session, user_id)
            row = (await session.execute(sa.text('''INSERT INTO fitcoach.coach_conversations
                (user_id, conversation_id, thread_id) VALUES (:user, :id, :thread) RETURNING *'''),
                {'user': user_id, 'id': conversation_id, 'thread': str(uuid4())})).mappings().one()
    return _conversation(row)


async def list_conversations(database, user_id: UUID, limit: int = 50, before: datetime | None = None):
    before_clause = ' AND updated_at < :before' if before is not None else ''
    params = {'user': user_id, 'limit': min(max(limit, 1), PAGE_MAX)}
    if before is not None:
        params['before'] = before
    async with database.sessions() as session:
        async with session.begin():
            await set_identity(session, user_id)
            rows = (await session.execute(sa.text(f'''SELECT * FROM fitcoach.coach_conversations
                WHERE user_id=:user{before_clause}
                ORDER BY updated_at DESC, conversation_id LIMIT :limit'''), params)).mappings().all()
    return [_conversation(row) for row in rows]


async def get_conversation(database, user_id: UUID, conversation_id: UUID, limit: int = 50, before: int | None = None):
    async with database.sessions() as session:
        async with session.begin():
            await set_identity(session, user_id)
            row = (await session.execute(sa.text('''SELECT * FROM fitcoach.coach_conversations
                WHERE user_id=:user AND conversation_id=:id'''), {'user': user_id, 'id': conversation_id})).mappings().first()
            if not row:
                raise HTTPException(404, 'Conversation not found')
            before_clause = 'AND sequence < :before' if before is not None else ''
            params = {'user': user_id, 'id': conversation_id,
                      'limit': min(max(limit, 1), PAGE_MAX)}
            if before is not None:
                params['before'] = before
            rows = (await session.execute(sa.text(f'''SELECT message_id, role, content, metadata, created_at, sequence
                FROM fitcoach.coach_messages WHERE user_id=:user AND conversation_id=:id
                {before_clause} ORDER BY sequence DESC LIMIT :limit'''), params)).mappings().all()
    return {**_conversation(row), 'messages': [
        {'id': str(m['message_id']), 'role': m['role'], 'text': m['content'],
         'metadata': m['metadata'], 'createdAt': m['created_at'].isoformat(), 'sequence': m['sequence']}
        for m in reversed(rows)], 'nextBefore': rows[-1]['sequence'] if len(rows) == min(max(limit, 1), PAGE_MAX) else None}


async def rename_conversation(database, user_id: UUID, conversation_id: UUID, title: str):
    async with database.sessions() as session:
        async with session.begin():
            await set_identity(session, user_id)
            row = (await session.execute(sa.text('''UPDATE fitcoach.coach_conversations
                SET title=:title, updated_at=now() WHERE user_id=:user AND conversation_id=:id RETURNING *'''),
                {'user': user_id, 'id': conversation_id, 'title': title.strip()})).mappings().first()
            if not row:
                raise HTTPException(404, 'Conversation not found')
    return _conversation(row)


async def delete_conversation(database, user_id: UUID, conversation_id: UUID):
    async with database.sessions() as session:
        async with session.begin():
            await set_identity(session, user_id)
            await lock_user_mutations(session, user_id)
            await expire_turns(session, user_id, conversation_id)
            active = await session.scalar(sa.text('''SELECT 1 FROM fitcoach.coach_turns
                WHERE user_id=:user AND conversation_id=:id AND status='started' LIMIT 1'''),
                {'user': user_id, 'id': conversation_id})
            if active:
                raise HTTPException(409, 'Wait for the current Coach message to finish before deleting this conversation.')
            row = (await session.execute(sa.text('''DELETE FROM fitcoach.coach_conversations
                WHERE user_id=:user AND conversation_id=:id RETURNING thread_id'''),
                {'user': user_id, 'id': conversation_id})).first()
            if not row:
                raise HTTPException(404, 'Conversation not found')
    return row[0]


async def conversation_messages(database, user_id: UUID, conversation_id: UUID):
    async with database.sessions() as session:
        async with session.begin():
            await set_identity(session, user_id)
            row = (await session.execute(sa.text('''SELECT thread_id FROM fitcoach.coach_conversations
                WHERE user_id=:user AND conversation_id=:id'''), {'user': user_id, 'id': conversation_id})).first()
            if not row:
                raise HTTPException(404, 'Conversation not found')
            result = (await session.execute(sa.text('''SELECT role, content FROM fitcoach.coach_messages
                WHERE user_id=:user AND conversation_id=:id ORDER BY sequence DESC LIMIT :limit'''),
                {'user': user_id, 'id': conversation_id, 'limit': CONTEXT_MESSAGES})).mappings().all()
    return row[0], [{'role': m['role'], 'text': m['content']} for m in reversed(result)]


async def begin_turn(database, user_id: UUID, conversation_id: UUID, request_id: UUID, user_text: str):
    """Claim a logical turn; every execution gets a fresh fenced lease."""
    attempt_id, user_message_id = uuid4(), uuid4()
    async with database.sessions() as session:
        async with session.begin():
            await set_identity(session, user_id)
            await lock_user_mutations(session, user_id)
            thread = await session.scalar(sa.text("""SELECT thread_id FROM fitcoach.coach_conversations
                WHERE user_id=:user AND conversation_id=:conversation FOR UPDATE"""),
                {'user': user_id, 'conversation': conversation_id})
            if not thread:
                raise HTTPException(404, 'Conversation not found')
            await expire_turns(session, user_id, conversation_id)
            params = {'user': user_id, 'conversation': conversation_id, 'request': request_id,
                      'attempt': attempt_id, 'seconds': LEASE_SECONDS}
            existing = (await session.execute(sa.text("""SELECT * FROM fitcoach.coach_turns
                WHERE user_id=:user AND conversation_id=:conversation AND request_id=:request FOR UPDATE"""),
                params)).mappings().first()
            if existing:
                old_text = await session.scalar(sa.text("""SELECT content FROM fitcoach.coach_messages
                    WHERE user_id=:user AND conversation_id=:conversation AND message_id=:message"""),
                    {**params, 'message': existing['user_message_id']})
                if old_text != user_text:
                    raise HTTPException(409, 'A message can only be retried with its original text.')
                if existing['status'] == 'completed':
                    return {'replay': True, 'text': existing['assistant_content'],
                            'metadata': existing['assistant_metadata'],
                            'assistantMessageId': str(existing['assistant_message_id'])}
            active = await session.scalar(sa.text("""SELECT 1 FROM fitcoach.coach_turns
                WHERE user_id=:user AND conversation_id=:conversation AND status='started'"""), params)
            if active:
                raise HTTPException(409, 'Another message is still processing in this conversation.')
            if existing:
                user_message_id = existing['user_message_id']
                await session.execute(sa.text("""UPDATE fitcoach.coach_turns SET status='started',
                    attempt_id=:attempt, attempt_started_at=clock_timestamp(),
                    lease_expires_at=clock_timestamp() + make_interval(secs => :seconds)
                    WHERE user_id=:user AND conversation_id=:conversation AND request_id=:request"""), params)
            else:
                seq = await session.scalar(sa.text("""SELECT COALESCE(max(sequence), 0) + 1
                    FROM fitcoach.coach_messages WHERE user_id=:user AND conversation_id=:conversation"""), params)
                await session.execute(sa.text("""INSERT INTO fitcoach.coach_messages
                    (message_id,user_id,conversation_id,sequence,role,content,metadata)
                    VALUES (:message,:user,:conversation,:sequence,'user',:content,'{}')"""),
                    {**params, 'message': user_message_id, 'sequence': seq, 'content': user_text})
                await session.execute(sa.text("""INSERT INTO fitcoach.coach_turns
                    (user_id,conversation_id,request_id,user_message_id,attempt_id,attempt_started_at,lease_expires_at)
                    VALUES (:user,:conversation,:request,:message,:attempt,clock_timestamp(),
                            clock_timestamp() + make_interval(secs => :seconds))"""),
                    {**params, 'message': user_message_id})
            await session.execute(sa.text("""UPDATE fitcoach.coach_conversations SET updated_at=now(),
                title=CASE WHEN title='New conversation' THEN left(:content, 160) ELSE title END
                WHERE user_id=:user AND conversation_id=:conversation"""), {**params, 'content': user_text})
    return {'replay': False, 'threadId': f'{thread}:{attempt_id}',
            'attemptId': attempt_id, 'userMessageId': str(user_message_id)}


async def finish_turn(database, user_id: UUID, conversation_id: UUID, request_id: UUID,
                      text: str, metadata: dict | None = None, *, attempt_id: UUID):
    assistant_id = uuid4()
    async with database.sessions() as session:
        async with session.begin():
            await set_identity(session, user_id)
            await lock_user_mutations(session, user_id)
            await assert_attempt(session, user_id, conversation_id, request_id, attempt_id)
            seq = await session.scalar(sa.text('''SELECT COALESCE(max(sequence), 0) + 1 FROM fitcoach.coach_messages
                WHERE user_id=:user AND conversation_id=:id'''), {'user': user_id, 'id': conversation_id})
            await session.execute(sa.text('''INSERT INTO fitcoach.coach_messages
                (message_id,user_id,conversation_id,sequence,role,content,metadata)
                VALUES (:message,:user,:conversation,:sequence,'assistant',:content,CAST(:metadata AS jsonb))'''),
                {'message': assistant_id, 'user': user_id, 'conversation': conversation_id, 'sequence': seq,
                 'content': text, 'metadata': json.dumps(metadata or {})})
            await session.execute(sa.text('''UPDATE fitcoach.coach_turns SET status='completed', assistant_content=:text,
                assistant_metadata=CAST(:metadata AS jsonb), assistant_message_id=:assistant, completed_at=now()
                WHERE user_id=:user AND conversation_id=:conversation AND request_id=:request'''),
                {'text': text, 'metadata': json.dumps(metadata or {}), 'assistant': assistant_id,
                 'user': user_id, 'conversation': conversation_id, 'request': request_id})
            await session.execute(sa.text('''UPDATE fitcoach.coach_conversations SET updated_at=now()
                WHERE user_id=:user AND conversation_id=:conversation'''), {'user': user_id, 'conversation': conversation_id})
    return str(assistant_id)


async def fail_turn(database, user_id: UUID, conversation_id: UUID, request_id: UUID, *, attempt_id: UUID):
    async with database.sessions() as session:
        async with session.begin():
            await set_identity(session, user_id)
            await session.execute(sa.text('''UPDATE fitcoach.coach_turns SET status='failed'
                WHERE user_id=:user AND conversation_id=:conversation AND request_id=:request AND status='started' AND attempt_id=:attempt '''),
                {'user': user_id, 'conversation': conversation_id, 'request': request_id, 'attempt': attempt_id})


async def read_turn(database, user_id: UUID, conversation_id: UUID, request_id: UUID):
    async with database.sessions() as session:
        async with session.begin():
            await set_identity(session, user_id)
            await lock_user_mutations(session, user_id)
            await expire_turns(session, user_id, conversation_id)
            row = (await session.execute(sa.text('''SELECT status, assistant_content, assistant_metadata,
                user_message_id, assistant_message_id, created_at, completed_at FROM fitcoach.coach_turns
                WHERE user_id=:user AND conversation_id=:conversation AND request_id=:request'''),
                {'user': user_id, 'conversation': conversation_id, 'request': request_id})).mappings().first()
    if not row:
        raise HTTPException(404, 'Turn not found')
    return {'status': row['status'], 'text': row['assistant_content'], 'metadata': row['assistant_metadata'],
            'userMessageId': str(row['user_message_id']),
            'messageId': str(row['assistant_message_id']) if row['assistant_message_id'] else None,
            'createdAt': row['created_at'].isoformat(),
            'completedAt': row['completed_at'].isoformat() if row['completed_at'] else None}
