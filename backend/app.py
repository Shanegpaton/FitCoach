"""Run with uvicorn backend.app:create_app --factory. No frontend synchronization."""
from contextlib import asynccontextmanager
import hashlib
import json
import logging
from typing import Annotated
from uuid import UUID

import httpx
import sqlalchemy as sa
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy.exc import DBAPIError, DataError, IntegrityError, TimeoutError
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from backend.auth import AuthVerifier, identity
from backend.config import Settings
from backend.database import Database, lock_user_mutations, set_identity
from backend.domain import Exercise, Page, Plan, Profile, ScheduleOverride, Session
from backend import schema as db_schema
from backend.store import RESOURCES, Store, etag

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


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    database = Database(settings)

    @asynccontextmanager
    async def lifespan(app):
        try:
            await database.verify_runtime_role()
            async with httpx.AsyncClient(timeout=10, follow_redirects=False) as client:
                app.state.auth = AuthVerifier(client, settings.supabase_url, settings.supabase_key)
                yield
        finally:
            await database.close()

    app = FastAPI(title='FitCoachGPT training API', version='1.0.0', lifespan=lifespan)
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
