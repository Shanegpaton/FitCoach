"""Run with uvicorn backend.app:create_app --factory. No frontend synchronization."""
from contextlib import asynccontextmanager
import hashlib
import json
import logging
import time
from typing import Annotated, Literal
from datetime import date
from uuid import UUID

import httpx
import sqlalchemy as sa
from cryptography.fernet import InvalidToken
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy.exc import DBAPIError, DataError, IntegrityError, TimeoutError
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

if __package__:
    from .auth import AuthVerifier, identity
    from .config import Settings
    from .database import Database, lock_user_mutations, set_identity
    from .domain import Exercise, Page, Plan, Profile, ScheduleOverride, Session
    from . import schema as db_schema
    from . import chatgpt_credentials as chatgpt
    from .agent import inference
    from .agent.graph import build_coach_graph
    from .agent.tools.database import TOOL_SPECS, run_database_tool
    from .agent.plan_proposal_service import approve_proposal, read_proposal, reject_proposal
    from .store import RESOURCES, Store, etag
else:
    from auth import AuthVerifier, identity
    from config import Settings
    from database import Database, lock_user_mutations, set_identity
    from domain import Exercise, Page, Plan, Profile, ScheduleOverride, Session
    import schema as db_schema
    import chatgpt_credentials as chatgpt
    from agent import inference
    from agent.graph import build_coach_graph
    from agent.tools.database import TOOL_SPECS, run_database_tool
    from agent.plan_proposal_service import approve_proposal, read_proposal, reject_proposal
    from store import RESOURCES, Store, etag

User = Annotated[UUID, Depends(identity)]
logger = logging.getLogger(__name__)
Limit = Annotated[int, Query(ge=1, le=500)]
Offset = Annotated[int, Query(ge=0)]
Match = Annotated[str | None, Header(alias='If-Match')]


class SyncMutation(BaseModel):
    model_config = ConfigDict(extra='forbid')
    mutationId: UUID
    resource: str
    id: str = Field(min_length=1)
    operation: str
    expectedEtag: str | None = None
    payload: dict | None = None


class SyncBatch(BaseModel):
    model_config = ConfigDict(extra='forbid')
    mutations: list[SyncMutation] = Field(min_length=1, max_length=50)


class ChatGPTHandoff(BaseModel):
    model_config = ConfigDict(extra='forbid')
    code: str = Field(min_length=40, max_length=100)


class CoachMessage(BaseModel):
    model_config = ConfigDict(extra='forbid')
    role: Literal['user', 'assistant']
    text: str = Field(min_length=1, max_length=5000)

    @field_validator('text')
    @classmethod
    def nonblank_text(cls, value: str) -> str:
        if not value.strip():
            raise ValueError('Coach message cannot be blank')
        return value


class CoachRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    messages: list[CoachMessage] = Field(min_length=1, max_length=16)
    localDate: date | None = None
    trainingDataReady: bool = False

    @model_validator(mode='after')
    def last_message_is_user(self):
        if self.messages[-1].role != 'user':
            raise ValueError('The last message must be from the user')
        return self


@asynccontextmanager
async def api_lifespan(app: FastAPI):
    database = app.state.database
    settings = app.state.settings
    try:
        await database.verify_runtime_role()
        async with httpx.AsyncClient(timeout=10, follow_redirects=False) as client:
            app.state.auth = AuthVerifier(client, settings.supabase_url, settings.supabase_key)
            yield
    finally:
        await database.close()


def configure_app(app: FastAPI, settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    database = Database(settings)
    app.title = 'FitCoachGPT training API'
    app.version = '1.0.0'
    app.state.settings = settings
    app.state.database = database
    app.add_middleware(CORSMiddleware, allow_origins=list(settings.cors_origins),
        allow_methods=['GET', 'POST', 'PUT', 'DELETE'], allow_headers=['Authorization', 'Content-Type', 'If-Match'],
        expose_headers=['ETag'])

    @app.exception_handler(IntegrityError)
    async def integrity_error(request, exc):
        return JSONResponse(status_code=409, content={'detail': 'Database integrity conflict'})

    @app.exception_handler(DataError)
    async def data_error(request, exc):
        return JSONResponse(status_code=422, content={'detail': 'Invalid database value'})

    @app.exception_handler(DBAPIError)
    @app.exception_handler(TimeoutError)
    async def database_error(request, exc):
        original = getattr(exc, 'orig', None)
        logger.warning('Database request failed; SQLSTATE %s', getattr(original, 'sqlstate', None))
        return JSONResponse(status_code=503, content={'detail': 'Database unavailable'})

    @asynccontextmanager
    async def store(user_id, mutation=False):
        async with database.sessions() as session:
            async with session.begin():
                # Reads assemble several relational queries; a consistent snapshot prevents
                # mixed documents during a concurrent aggregate edit.
                if not mutation:
                    await session.execute(sa.text('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'))
                await set_identity(session, user_id)
                yield Store(session, user_id)

    @app.get('/health')
    async def health():
        return {'status': 'ok'}

    @app.get('/v1/me')
    async def me(user: User):
        return {'id': str(user)}

    @app.get('/v1/chatgpt/connection')
    async def chatgpt_connection(user: User):
        async with database.sessions() as session:
            async with session.begin():
                await set_identity(session, user)
                row = (await session.execute(sa.text('''SELECT email, name, plan_usage_granted
                    FROM fitcoach.chatgpt_credentials WHERE user_id = :user_id'''),
                    {'user_id': user})).mappings().first()
        return {'connected': bool(row), 'email': row['email'] if row else None,
                'name': row['name'] if row else None,
                'planUsageGranted': row['plan_usage_granted'] if row else None,
                'storedInBackend': bool(row)}

    async def vm_control(request: Request, path: str, method: str = 'GET') -> dict:
        try:
            origin = chatgpt.vm_origin()
        except ValueError:
            raise HTTPException(503, 'ChatGPT VM is not configured') from None
        try:
            async with httpx.AsyncClient(timeout=15, follow_redirects=False) as client:
                result = await client.request(method, f'{origin}/v1/{path}',
                    headers={'Authorization': request.headers['authorization']})
        except httpx.RequestError:
            raise HTTPException(503, 'The VM is unavailable') from None
        if result.status_code == 204:
            return {}
        if result.status_code != 200:
            try:
                detail = result.json().get('detail', 'The VM request failed')
            except (ValueError, AttributeError):
                detail = 'The VM request failed'
            raise HTTPException(result.status_code if result.status_code in (403, 404, 409, 503) else 502, detail)
        try:
            return result.json()
        except ValueError:
            raise HTTPException(502, 'The VM returned an invalid response') from None

    @app.get('/v1/chatgpt/vm/connection')
    async def vm_connection(request: Request, user: User):
        return await vm_control(request, 'connection')

    @app.post('/v1/chatgpt/vm/attempts')
    async def vm_start(request: Request, user: User):
        return await vm_control(request, 'attempts', 'POST')

    @app.get('/v1/chatgpt/vm/attempts/{attempt_id}')
    async def vm_attempt(attempt_id: UUID, request: Request, user: User):
        return await vm_control(request, f'attempts/{attempt_id}')

    @app.delete('/v1/chatgpt/vm/connection')
    async def vm_disconnect(request: Request, user: User):
        return await vm_control(request, 'connection', 'DELETE')

    @app.post('/v1/chatgpt/handoff')
    async def claim_chatgpt_handoff(body: ChatGPTHandoff, request: Request, user: User):
        try:
            secret = chatgpt.handoff_secret()
            origin = chatgpt.vm_origin()
            authorization = request.headers['authorization']
        except (ValueError, KeyError):
            raise HTTPException(503, 'ChatGPT credential handoff is not configured') from None
        try:
            async with httpx.AsyncClient(timeout=15, follow_redirects=False) as client:
                response = await client.post(f'{origin}/v1/handoff/redeem',
                    headers={'Authorization': authorization, 'X-FitCoach-Handoff-Key': secret},
                    json={'code': body.code})
            if response.status_code != 200:
                raise HTTPException(502, 'The VM credential handoff expired or failed')
            record = chatgpt.validate_record(response.json(), str(user))
            ciphertext = chatgpt.encrypt_record(record)
        except httpx.RequestError:
            raise HTTPException(503, 'The VM is unavailable for credential handoff') from None
        except (ValueError, TypeError, KeyError):
            raise HTTPException(502, 'The VM returned an invalid credential record') from None
        async with database.sessions() as session:
            async with session.begin():
                await set_identity(session, user)
                await session.execute(sa.text('''INSERT INTO fitcoach.chatgpt_credentials
                    (user_id, ciphertext, email, name, plan_usage_granted)
                    VALUES (:user_id, :ciphertext, :email, :name, :granted)
                    ON CONFLICT (user_id) DO UPDATE SET ciphertext = EXCLUDED.ciphertext,
                        email = EXCLUDED.email, name = EXCLUDED.name,
                        plan_usage_granted = EXCLUDED.plan_usage_granted, updated_at = now()'''),
                    {'user_id': user, 'ciphertext': ciphertext, 'email': record.get('email'),
                     'name': record.get('name'), 'granted': record['plan_usage_granted']})
        cleanup_pending = False
        try:
            async with httpx.AsyncClient(timeout=15, follow_redirects=False) as client:
                confirmed = await client.post(f'{origin}/v1/handoff/confirm',
                    headers={'Authorization': authorization, 'X-FitCoach-Handoff-Key': secret})
            cleanup_pending = confirmed.status_code != 204
        except httpx.RequestError:
            cleanup_pending = True
        return {'connected': True, 'email': record.get('email'), 'name': record.get('name'),
                'planUsageGranted': record['plan_usage_granted'], 'storedInBackend': True,
                'vmCleanupPending': cleanup_pending}

    @app.post('/v1/chatgpt/vm/save')
    async def save_vm_connection(request: Request, user: User):
        handoff = await vm_control(request, 'handoff', 'POST')
        try:
            body = ChatGPTHandoff(code=handoff['code'])
        except (KeyError, TypeError, ValidationError):
            raise HTTPException(502, 'The VM returned an invalid handoff') from None
        return await claim_chatgpt_handoff(body, request, user)

    @app.post('/v1/chatgpt/vm/cleanup')
    async def cleanup_vm_connection(request: Request, user: User):
        async with database.sessions() as session:
            async with session.begin():
                await set_identity(session, user)
                stored = await session.scalar(sa.text('''SELECT 1 FROM fitcoach.chatgpt_credentials
                    WHERE user_id = :user_id'''), {'user_id': user})
        if not stored:
            raise HTTPException(409, 'Save the connection before clearing the VM')
        current = await vm_control(request, 'connection')
        if not current.get('paired') or not current.get('connected'):
            return {'vmCleanupPending': False}
        try:
            origin = chatgpt.vm_origin()
            secret = chatgpt.handoff_secret()
            async with httpx.AsyncClient(timeout=15, follow_redirects=False) as client:
                result = await client.post(f'{origin}/v1/handoff/confirm', headers={
                    'Authorization': request.headers['authorization'], 'X-FitCoach-Handoff-Key': secret})
        except (ValueError, httpx.RequestError):
            raise HTTPException(503, 'The VM could not be cleared') from None
        if result.status_code != 204:
            raise HTTPException(503, 'The VM could not be cleared')
        return {'vmCleanupPending': False}

    @app.delete('/v1/chatgpt/connection')
    async def delete_chatgpt_connection(user: User):
        async with database.sessions() as session:
            async with session.begin():
                await set_identity(session, user)
                ciphertext = await session.scalar(sa.text('''SELECT ciphertext FROM fitcoach.chatgpt_credentials
                    WHERE user_id = :user_id'''), {'user_id': user})
        if not ciphertext:
            return {'cleared': True, 'revocationConfirmed': None}
        try:
            record = chatgpt.decrypt_record(ciphertext)
        except (InvalidToken, ValueError, UnicodeDecodeError):
            # A wrong encryption key must not silently discard the only recoverable record.
            raise HTTPException(503, 'ChatGPT credential store cannot be decrypted') from None
        revoked = await chatgpt.revoke_record(record)
        async with database.sessions() as session:
            async with session.begin():
                await set_identity(session, user)
                removed = await session.scalar(sa.text('''DELETE FROM fitcoach.chatgpt_credentials
                    WHERE user_id = :user_id AND ciphertext = :ciphertext RETURNING user_id'''),
                    {'user_id': user, 'ciphertext': ciphertext})
                if not removed:
                    raise HTTPException(409, 'ChatGPT connection changed during disconnect; retry')
        return {'cleared': True, 'revocationConfirmed': revoked}

    @app.post('/v1/chatgpt/coach')
    async def chatgpt_coach(body: CoachRequest, user: User):
        # Hold the account row lock during refresh so concurrent workers cannot rotate
        # the same single-use refresh token independently.
        async with database.sessions() as session:
            async with session.begin():
                await set_identity(session, user)
                ciphertext = await session.scalar(sa.text('''SELECT ciphertext FROM fitcoach.chatgpt_credentials
                    WHERE user_id = :user_id FOR UPDATE'''), {'user_id': user})
                if not ciphertext:
                    raise HTTPException(409, 'Connect ChatGPT in Settings first.')
                try:
                    record = chatgpt.decrypt_record(ciphertext)
                except (InvalidToken, ValueError, UnicodeDecodeError):
                    raise HTTPException(503, 'ChatGPT credential store cannot be decrypted') from None
                if not record.get('plan_usage_granted') or 'chatgpt.tokens.use.direct' not in record.get('scopes', []):
                    raise HTTPException(403, 'ChatGPT plan usage was not granted. Reconnect in Settings.')
                if record['expires_at'] <= time.time() + 120:
                    try:
                        record = await inference.refresh_record(record)
                    except inference.InferenceError as exc:
                        raise HTTPException(exc.status, exc.message) from None
                    await session.execute(sa.text('''UPDATE fitcoach.chatgpt_credentials
                        SET ciphertext = :ciphertext, updated_at = now() WHERE user_id = :user_id'''),
                        {'user_id': user, 'ciphertext': chatgpt.encrypt_record(record)})
        try:
            async def respond(input_items):
                return await inference.complete_agent_turn(record['access_token'], input_items,
                    TOOL_SPECS if body.trainingDataReady else [], body.trainingDataReady)

            async def run_tool(name, arguments):
                if not body.trainingDataReady:
                    raise inference.InferenceError(502, 'Training data is still syncing.')
                return await run_database_tool(name, arguments, database, user,
                    body.localDate or date.today())

            result = await build_coach_graph(respond, run_tool).ainvoke({
                'input': [{'role': message.role, 'content': message.text} for message in body.messages],
            })
        except inference.InferenceError as exc:
            raise HTTPException(exc.status, exc.message) from None
        return {'text': result['text'], 'proposal': result.get('proposal')}

    @app.get('/v1/coach/proposals/{proposal_id}')
    async def coach_proposal(proposal_id: UUID, user: User):
        return await read_proposal(database, user, proposal_id)

    @app.post('/v1/coach/proposals/{proposal_id}/reject')
    async def coach_reject(proposal_id: UUID, user: User):
        return await reject_proposal(database, user, proposal_id)

    @app.post('/v1/coach/proposals/{proposal_id}/approve')
    async def coach_approve(proposal_id: UUID, user: User):
        return await approve_proposal(database, user, proposal_id)

    @app.get('/v1/sync/changes')
    async def sync_changes(user: User, cursor: Annotated[int, Query(ge=0)] = 0,
                           limit: Annotated[int, Query(ge=1, le=250)] = 100):
        async with store(user) as data:
            return await data.changes(cursor, limit)

    @app.get('/v1/sync/records/{resource}/{client_id}')
    async def sync_record(resource: str, client_id: str, user: User):
        async with store(user) as data:
            return await data.sync_record(resource, client_id)

    @app.post('/v1/sync/mutations')
    async def sync_mutations(batch: SyncBatch, user: User):
        models = {'profile': Profile, 'exercises': Exercise, 'plans': Plan, 'sessions': Session,
                  'schedule-overrides': ScheduleOverride}
        results = []
        for mutation in batch.mutations:
            canonical = json.dumps(mutation.model_dump(mode='json'), sort_keys=True, separators=(',', ':'))
            digest = hashlib.sha256(canonical.encode()).hexdigest()
            result = None
            try:
                async with database.sessions() as session:
                    async with session.begin():
                        await set_identity(session, user)
                        await lock_user_mutations(session, user)
                        existing = (await session.execute(sa.select(db_schema.mutation_receipts).where(
                            db_schema.mutation_receipts.c.user_id == user,
                            db_schema.mutation_receipts.c.mutation_id == mutation.mutationId))).mappings().first()
                        if existing:
                            if existing['request_hash'] != digest:
                                result = dict(mutationId=str(mutation.mutationId), status=409,
                                    resource=mutation.resource, id=mutation.id, etag=None,
                                    document=None, error='Idempotency key was already used with different content')
                            else:
                                result = json.loads(existing['response_body'])
                        else:
                            if mutation.resource not in models or mutation.operation not in ('upsert', 'delete'):
                                raise HTTPException(422, 'Unsupported sync mutation')
                            data = Store(session, user)
                            if mutation.operation == 'upsert':
                                if mutation.payload is None or mutation.payload.get('id') != mutation.id:
                                    raise HTTPException(422, 'Mutation ID must match the payload ID')
                                try:
                                    document = models[mutation.resource].model_validate(mutation.payload)
                                except ValidationError as error:
                                    raise HTTPException(422, error.errors(include_url=False)) from error
                                saved, row, created = await data.put(mutation.resource, document,
                                    mutation.expectedEtag, create_only=mutation.expectedEtag is None)
                                status = 201 if created else 200
                                response_etag = etag(row)
                            else:
                                if mutation.payload is not None:
                                    raise HTTPException(422, 'Delete mutations cannot include a payload')
                                await data.delete(mutation.resource, mutation.id, mutation.expectedEtag)
                                row = await data.root(RESOURCES[mutation.resource], mutation.id, live=False)
                                saved, status, response_etag = None, 204, etag(row)
                            result = dict(mutationId=str(mutation.mutationId), status=status,
                                resource=mutation.resource, id=mutation.id, etag=response_etag,
                                document=saved, error=None)
                            await session.execute(db_schema.mutation_receipts.insert().values(
                                user_id=user, mutation_id=mutation.mutationId, request_hash=digest,
                                status_code=status,
                                response_body=json.dumps(result, sort_keys=True, separators=(',', ':')),
                                response_etag=response_etag))
            except HTTPException as error:
                detail = error.detail if isinstance(error.detail, str) else 'Invalid sync mutation'
                result = dict(mutationId=str(mutation.mutationId), status=error.status_code,
                    resource=mutation.resource, id=mutation.id, etag=None, document=None, error=detail)
            except IntegrityError:
                result = dict(mutationId=str(mutation.mutationId), status=409,
                    resource=mutation.resource, id=mutation.id, etag=None, document=None,
                    error='Database integrity conflict')
            except DataError:
                result = dict(mutationId=str(mutation.mutationId), status=422,
                    resource=mutation.resource, id=mutation.id, etag=None, document=None,
                    error='Invalid database value')
            results.append(result)
        return {'results': results}

    @app.get('/v1/profile', response_model=Profile)
    async def profile(response: Response, user: User):
        async with store(user) as data:
            document, row = await data.read('profile', 'profile')
            response.headers['ETag'] = etag(row)
            return document

    @app.put('/v1/profile', response_model=Profile)
    async def put_profile(body: Profile, response: Response, user: User, if_match: Match = None):
        async with store(user, mutation=True) as data:
            document, row, created = await data.put('profile', body, if_match)
            response.headers['ETag'] = etag(row)
            response.status_code = 201 if created else 200
            return document

    def register(resource, model, readonly=False):
        async def listing(user: User, limit: Limit = 100, offset: Offset = 0):
            async with store(user) as data:
                return await data.list(resource, limit, offset)

        async def read(client_id: str, response: Response, user: User):
            async with store(user) as data:
                document, row = await data.read(resource, client_id)
                if not readonly:
                    response.headers['ETag'] = etag(row)
                return document

        async def put(client_id: str, body: model, response: Response, user: User, if_match: Match = None):
            if client_id != body.id:
                raise HTTPException(422, 'Path ID must match document ID')
            async with store(user, mutation=True) as data:
                document, row, created = await data.put(resource, body, if_match)
                response.headers['ETag'] = etag(row)
                response.status_code = 201 if created else 200
                return document

        async def delete(client_id: str, user: User, if_match: Match = None):
            async with store(user, mutation=True) as data:
                await data.delete(resource, client_id, if_match)
            return Response(status_code=204)

        base = f'/v1/{resource}'
        app.add_api_route(base, listing, methods=['GET'], response_model=Page[model], name=f'list_{resource}')
        app.add_api_route(base + '/{client_id}', read, methods=['GET'], response_model=model, name=f'get_{resource}')
        if not readonly:
            app.add_api_route(base + '/{client_id}', put, methods=['PUT'], response_model=model, name=f'put_{resource}')
            app.add_api_route(base + '/{client_id}', delete, methods=['DELETE'], status_code=204, name=f'delete_{resource}')

    for resource, model in [('exercises', Exercise), ('plans', Plan), ('sessions', Session),
                             ('schedule-overrides', ScheduleOverride)]:
        register(resource, model)
    register('catalog', Exercise, readonly=True)
    return app


def create_app(settings: Settings | None = None) -> FastAPI:
    return configure_app(FastAPI(lifespan=api_lifespan), settings)
