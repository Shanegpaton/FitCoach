"""Authenticated context controls; client bodies never supply ownership."""
import asyncio
import json
from typing import Annotated
from uuid import UUID

from fastapi import Depends, Header, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator
import sqlalchemy as sa

from . import context_store as contexts
from .inference import InferenceError, resolve_model
from .tools.database import TOOL_SPECS
try:
    from ..auth import identity
except ImportError:
    from auth import identity

User = Annotated[UUID, Depends(identity)]
Match = Annotated[str | None, Header(alias='If-Match')]


class MemoryEdit(BaseModel):
    model_config = ConfigDict(extra='forbid')
    content: str = Field(min_length=1, max_length=1000)

    @field_validator('content')
    @classmethod
    def nonblank(cls, value):
        if not value.strip():
            raise ValueError('Memory cannot be blank')
        return value.strip()


class MaintenanceRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    conversationId: UUID | None = None


class MemorySettings(BaseModel):
    model_config = ConfigDict(extra='forbid')
    automatic: bool


def check_match(match, version):
    if match is None:
        raise HTTPException(428, 'If-Match is required. Reload the current version first.')
    if match != f'"{version}"':
        raise HTTPException(412, 'Memory changed. Reload before editing or deleting.')


def register_context_routes(app, database, credentials):
    @app.get('/v1/coach/memories')
    async def memories(user: User, response: Response):
        async with contexts.transaction(database, user, True) as session:
            await session.execute(sa.text('INSERT INTO fitcoach.coach_memory_settings(user_id) VALUES (:u) ON CONFLICT DO NOTHING'), {'u': user})
            settings = (await session.execute(sa.text('SELECT * FROM fitcoach.coach_memory_settings WHERE user_id=:u'), {'u': user})).mappings().one()
            rows = (await session.execute(sa.text('SELECT * FROM fitcoach.coach_memories WHERE user_id=:u AND NOT deleted ORDER BY updated_at DESC'), {'u': user})).mappings().all()
        response.headers['ETag'] = f'"{settings["version"]}"'
        return {'enabled': contexts.memory_enabled(), 'automatic': settings['automatic'], 'etag': f'"{settings["version"]}"',
                'capacityReached': len(rows) >= 100, 'items': [
            {'id': str(m['id']), 'content': m['content'], 'category': m['category'], 'edited': m['edited'],
             'updatedAt': m['updated_at'].isoformat(), 'sources': m['source_messages'], 'etag': f'"{m["version"]}"'} for m in rows]}

    @app.patch('/v1/coach/memory-settings')
    async def settings_update(body: MemorySettings, user: User, if_match: Match = None):
        async with contexts.transaction(database, user, True) as session:
            row = (await session.execute(sa.text('SELECT * FROM fitcoach.coach_memory_settings WHERE user_id=:u FOR UPDATE'), {'u': user})).mappings().first()
            if not row:
                raise HTTPException(404, 'Load memory settings first.')
            check_match(if_match, row['version'])
            await session.execute(sa.text('UPDATE fitcoach.coach_memory_settings SET automatic=:a,version=version+1,generation=generation+1 WHERE user_id=:u'), {'u': user, 'a': body.automatic})
            # Never backfill statements made while automatic memory was disabled.
            await session.execute(sa.text('''UPDATE fitcoach.coach_context SET memory_cursor=(SELECT COALESCE(max(sequence),0)
                FROM fitcoach.coach_messages m WHERE m.conversation_id=coach_context.conversation_id) WHERE user_id=:u'''), {'u': user})
            await session.execute(sa.text("UPDATE fitcoach.coach_context_jobs SET requested=false,attempt=NULL,lease_until=NULL WHERE user_id=:u AND kind='memory'"), {'u': user})
        return {'automatic': body.automatic}

    @app.patch('/v1/coach/memories/{memory_id}')
    async def edit_memory(memory_id: UUID, body: MemoryEdit, user: User, if_match: Match = None):
        async with contexts.transaction(database, user, True) as session:
            row = (await session.execute(sa.text('SELECT * FROM fitcoach.coach_memories WHERE user_id=:u AND id=:id AND NOT deleted FOR UPDATE'), {'u': user, 'id': memory_id})).mappings().first()
            if not row:
                raise HTTPException(404, 'Memory not found')
            check_match(if_match, row['version'])
            await session.execute(sa.text('''UPDATE fitcoach.coach_memories SET content=:text,edited=true,source_conversation=NULL,
                source_sequence=NULL,source_at=NULL,source_messages='[]',version=version+1,updated_at=now() WHERE id=:id'''), {'text': body.content, 'id': memory_id})
            await session.execute(sa.text('UPDATE fitcoach.coach_memory_settings SET version=version+1,generation=generation+1 WHERE user_id=:u'), {'u': user})
        return {'saved': True}

    @app.delete('/v1/coach/memories/{memory_id}', status_code=204)
    async def delete_memory(memory_id: UUID, user: User, if_match: Match = None):
        async with contexts.transaction(database, user, True) as session:
            row = (await session.execute(sa.text('SELECT version FROM fitcoach.coach_memories WHERE user_id=:u AND id=:id AND NOT deleted FOR UPDATE'), {'u': user, 'id': memory_id})).first()
            if not row:
                raise HTTPException(404, 'Memory not found')
            check_match(if_match, row[0])
            await session.execute(sa.text("UPDATE fitcoach.coach_memories SET deleted=true,content='',source_messages='[]',source_conversation=NULL,version=version+1,updated_at=now() WHERE id=:id"), {'id': memory_id})
            await session.execute(sa.text('UPDATE fitcoach.coach_memory_settings SET version=version+1,generation=generation+1 WHERE user_id=:u'), {'u': user})
        return Response(status_code=204)

    @app.delete('/v1/coach/memories', status_code=204)
    async def clear_memories(user: User, if_match: Match = None):
        async with contexts.transaction(database, user, True) as session:
            row = (await session.execute(sa.text('SELECT version FROM fitcoach.coach_memory_settings WHERE user_id=:u FOR UPDATE'), {'u': user})).first()
            if not row:
                raise HTTPException(404, 'Load memory settings first.')
            check_match(if_match, row[0])
            await session.execute(sa.text("UPDATE fitcoach.coach_memories SET deleted=true,content='',source_messages='[]',source_conversation=NULL,version=version+1,updated_at=now() WHERE user_id=:u"), {'u': user})
            await session.execute(sa.text('UPDATE fitcoach.coach_memory_settings SET version=version+1,generation=generation+1 WHERE user_id=:u'), {'u': user})
            await session.execute(sa.text('''UPDATE fitcoach.coach_context SET memory_cursor=(SELECT COALESCE(max(sequence),0)
                FROM fitcoach.coach_messages m WHERE m.conversation_id=coach_context.conversation_id) WHERE user_id=:u'''), {'u': user})
            await session.execute(sa.text("UPDATE fitcoach.coach_context_jobs SET requested=false,attempt=NULL,lease_until=NULL WHERE user_id=:u AND kind='memory'"), {'u': user})
        return Response(status_code=204)

    @app.get('/v1/coach/conversations/{conversation_id}/context')
    async def conversation_context(conversation_id: UUID, user: User):
        if not contexts.enabled():
            return {'enabled': False, 'summary': '', 'summaryAvailable': False, 'maintenancePending': False, 'compactionWaiting': False}
        async with contexts.transaction(database, user, True) as session:
            await contexts.ensure(session, user, conversation_id)
        ctx, _ = await contexts.state(database, user, conversation_id)
        return {'enabled': True, 'summary': ctx['summary'], **await contexts.status(database, user, conversation_id)}

    @app.post('/v1/coach/maintenance')
    async def maintenance(user: User, body: MaintenanceRequest = MaintenanceRequest()):
        if not contexts.enabled():
            return {'pending': False, 'processed': False}
        record = budget = None
        if body.conversationId:
            try:
                record = await credentials(user)
                budget = await resolve_model(record['access_token'], record.get('preferred_model'))
                async with contexts.transaction(database, user, True) as session:
                    await contexts.ensure(session, user, body.conversationId)
                context_session = contexts.ContextSession(database, user, body.conversationId, record['access_token'], budget, TOOL_SPECS, True)
                await context_session.queue_next()
                await contexts.queue_memory(database, user, body.conversationId)
            except InferenceError as error:
                raise HTTPException(error.status, error.message) from None
        job = await contexts.claim_job(database, user)
        if not job:
            async with contexts.transaction(database, user) as session:
                pending = await session.scalar(sa.text('SELECT EXISTS(SELECT 1 FROM fitcoach.coach_context_jobs WHERE user_id=:u AND requested)'), {'u': user})
            return {'pending': pending, 'processed': False}
        try:
            async with asyncio.timeout(70):
                record = record or await credentials(user)
                budget = budget or await resolve_model(record['access_token'], record.get('preferred_model'))
                processed = await contexts.process_job(database, user, record['access_token'], budget, job)
        except InferenceError as error:
            raise HTTPException(error.status, error.message) from None
        except asyncio.TimeoutError:
            raise HTTPException(504, 'Context maintenance will resume later.') from None
        return {'pending': True, 'processed': bool(processed), 'kind': job['kind'],
                'memoryChanged': bool(processed and isinstance(processed, dict) and processed.get('memoryChanged'))}
