"""Verified catalog choices and versioned account model preferences."""
from typing import Annotated
from uuid import UUID

from fastapi import Depends, Header, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field
import sqlalchemy as sa

from . import inference
from .context_store import transaction
try:
    from ..auth import identity
except ImportError:
    from auth import identity

User = Annotated[UUID, Depends(identity)]
Match = Annotated[str | None, Header(alias='If-Match')]


class ModelPreference(BaseModel):
    model_config = ConfigDict(extra='forbid')
    preferredModel: str | None = Field(min_length=1, max_length=200, pattern=r'^\S+$')


async def model_settings(database, user):
    async with transaction(database, user, True) as session:
        await session.execute(sa.text('INSERT INTO fitcoach.coach_model_settings(user_id) VALUES (:u) ON CONFLICT DO NOTHING'), {'u': user})
        row = (await session.execute(sa.text('SELECT * FROM fitcoach.coach_model_settings WHERE user_id=:u'), {'u': user})).mappings().one()
        return dict(row)


def register_model_routes(app, database, credentials):
    @app.get('/v1/chatgpt/models')
    async def models(user: User, response: Response):
        settings = await model_settings(database, user)
        preferred = inference.preferred_model(settings['preferred_model'])
        choices = []
        error = None
        try:
            record = await credentials(user)
            choices = [{'id': item['slug']} for item in await inference.available_models(record['access_token'])]
        except inference.InferenceError as exc:
            error = exc.message
        except HTTPException as exc:
            error = str(exc.detail)
        selected = preferred if any(item['id'] == preferred for item in choices) else None
        response.headers['ETag'] = f'"{settings["version"]}"'
        return {'preferredModel': settings['preferred_model'], 'defaultModel': inference.preferred_model(),
                'selectedModel': selected, 'available': selected is not None, 'models': choices,
                'catalogError': error, 'etag': response.headers['ETag']}

    @app.put('/v1/chatgpt/models')
    async def choose_model(body: ModelPreference, user: User, if_match: Match = None):
        if if_match is None:
            raise HTTPException(428, 'If-Match is required. Reload model settings first.')
        try:
            record = await credentials(user)
            # Verify even a deployment-default choice before saving. No fallback inference.
            await inference.resolve_model(record['access_token'], body.preferredModel)
        except inference.InferenceError as exc:
            raise HTTPException(exc.status, exc.message) from None
        async with transaction(database, user, True) as session:
            row = (await session.execute(sa.text('SELECT version FROM fitcoach.coach_model_settings WHERE user_id=:u FOR UPDATE'), {'u': user})).first()
            if not row or if_match != f'"{row[0]}"':
                raise HTTPException(412, 'Coach model changed on another device. Reload before choosing a model.')
            await session.execute(sa.text('UPDATE fitcoach.coach_model_settings SET preferred_model=:m,version=version+1 WHERE user_id=:u'), {'u': user, 'm': body.preferredModel})
        return {'saved': True, 'preferredModel': body.preferredModel}
