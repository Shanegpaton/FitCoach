"""Account-scoped Coach conversation records and bounded message history."""
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
    """Durably claim an idempotency key before calling the model."""
    user_message_id = uuid4()
    async with database.sessions() as session:
        async with session.begin():
            await set_identity(session, user_id)
            await lock_user_mutations(session, user_id)
            existing = (await session.execute(sa.text('''SELECT status, assistant_content, assistant_metadata, assistant_message_id, user_message_id
                FROM fitcoach.coach_turns WHERE user_id=:user AND conversation_id=:conversation AND request_id=:request FOR UPDATE'''),
                {'user': user_id, 'conversation': conversation_id, 'request': request_id})).mappings().first()
            if existing:
                if existing['status'] == 'completed':
                    return {'replay': True, 'text': existing['assistant_content'],
                            'metadata': existing['assistant_metadata'], 'assistantMessageId': str(existing['assistant_message_id'])}
                if existing['status'] == 'started':
                    raise HTTPException(409, 'This message is already being processed. Check the conversation before retrying.')
                old_text = await session.scalar(sa.text('''SELECT content FROM fitcoach.coach_messages
                    WHERE user_id=:user AND conversation_id=:conversation AND message_id=:message'''),
                    {'user': user_id, 'conversation': conversation_id, 'message': existing['user_message_id']})
                if old_text != user_text:
                    raise HTTPException(409, 'A failed message can only be retried with its original text.')
                thread = await session.scalar(sa.text('''SELECT thread_id FROM fitcoach.coach_conversations
                    WHERE user_id=:user AND conversation_id=:conversation'''),
                    {'user': user_id, 'conversation': conversation_id})
                await session.execute(sa.text('''UPDATE fitcoach.coach_turns SET status='started'
                    WHERE user_id=:user AND conversation_id=:conversation AND request_id=:request'''),
                    {'user': user_id, 'conversation': conversation_id, 'request': request_id})
                return {'replay': False, 'threadId': thread, 'userMessageId': str(existing['user_message_id'])}
            row = (await session.execute(sa.text('''SELECT thread_id FROM fitcoach.coach_conversations
                WHERE user_id=:user AND conversation_id=:id FOR UPDATE'''), {'user': user_id, 'id': conversation_id})).first()
            if not row:
                raise HTTPException(404, 'Conversation not found')
            seq = await session.scalar(sa.text('''SELECT COALESCE(max(sequence), 0) + 1 FROM fitcoach.coach_messages
                WHERE user_id=:user AND conversation_id=:id'''), {'user': user_id, 'id': conversation_id})
            active = await session.scalar(sa.text('''SELECT 1 FROM fitcoach.coach_turns
                WHERE user_id=:user AND conversation_id=:conversation AND status='started' LIMIT 1'''),
                {'user': user_id, 'conversation': conversation_id})
            if active:
                raise HTTPException(409, 'Another message is still processing in this conversation.')
            await session.execute(sa.text('''INSERT INTO fitcoach.coach_messages
                (message_id,user_id,conversation_id,sequence,role,content,metadata)
                VALUES (:message,:user,:conversation,:sequence,'user',:content,'{}')'''),
                {'message': user_message_id, 'user': user_id, 'conversation': conversation_id,
                 'sequence': seq, 'content': user_text})
            await session.execute(sa.text('''INSERT INTO fitcoach.coach_turns
                (user_id,conversation_id,request_id,user_message_id) VALUES (:user,:conversation,:request,:message)'''),
                {'user': user_id, 'conversation': conversation_id, 'request': request_id, 'message': user_message_id})
            await session.execute(sa.text('''UPDATE fitcoach.coach_conversations SET updated_at=now(),
                title=CASE WHEN title='New conversation' THEN left(:content, 160) ELSE title END
                WHERE user_id=:user AND conversation_id=:conversation'''),
                {'user': user_id, 'conversation': conversation_id, 'content': user_text})
    return {'replay': False, 'threadId': row[0], 'userMessageId': str(user_message_id)}


async def finish_turn(database, user_id: UUID, conversation_id: UUID, request_id: UUID,
                      text: str, metadata: dict | None = None):
    assistant_id = uuid4()
    async with database.sessions() as session:
        async with session.begin():
            await set_identity(session, user_id)
            await lock_user_mutations(session, user_id)
            row = (await session.execute(sa.text('''SELECT status FROM fitcoach.coach_turns
                WHERE user_id=:user AND conversation_id=:conversation AND request_id=:request FOR UPDATE'''),
                {'user': user_id, 'conversation': conversation_id, 'request': request_id})).mappings().first()
            if not row:
                raise HTTPException(404, 'Turn not found')
            if row['status'] == 'completed':
                return
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


async def fail_turn(database, user_id: UUID, conversation_id: UUID, request_id: UUID):
    async with database.sessions() as session:
        async with session.begin():
            await set_identity(session, user_id)
            await session.execute(sa.text('''UPDATE fitcoach.coach_turns SET status='failed'
                WHERE user_id=:user AND conversation_id=:conversation AND request_id=:request AND status='started' '''),
                {'user': user_id, 'conversation': conversation_id, 'request': request_id})


async def read_turn(database, user_id: UUID, conversation_id: UUID, request_id: UUID):
    async with database.sessions() as session:
        async with session.begin():
            await set_identity(session, user_id)
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
