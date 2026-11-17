"""Request correlation and an authenticated, metadata-only browser error sink."""
import logging
import time
from datetime import datetime
from typing import Literal
from uuid import UUID, uuid4

from fastapi import Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
try:
    from .auth import identity
except ImportError:  # backend/ is the deployment project root
    from auth import identity

logger = logging.getLogger('fitcoach.diagnostics')
logger.setLevel(logging.INFO)


class DiagnosticEvent(BaseModel):
    model_config = ConfigDict(extra='forbid')
    code: Literal['render_error', 'unhandled_error', 'unhandled_rejection', 'api_error', 'sync_error']
    at: datetime
    requestId: UUID | None = None
    status: int | None = Field(default=None, ge=100, le=599)


def register_diagnostics(app):
    @app.middleware('http')
    async def correlate(request, call_next):
        request_id = str(uuid4())  # Never trust a client-supplied log identifier.
        request.state.request_id = request_id
        start = time.monotonic()
        try:
            response = await call_next(request)
        except Exception as error:
            logger.error('request_failed request_id=%s error_type=%s', request_id, type(error).__name__)
            response = JSONResponse(status_code=500, content={'detail': 'An unexpected error occurred'})
        response.headers['X-Request-ID'] = request_id
        route = request.scope.get('route')
        # Templates, not raw paths or queries (which may contain account/user data).
        logger.info('request request_id=%s method=%s route=%s status=%d duration_ms=%.1f',
                    request_id, request.method, getattr(route, 'path', 'unmatched'), response.status_code,
                    (time.monotonic() - start) * 1000)
        return response

    @app.post('/v1/diagnostics', status_code=204)
    async def browser_diagnostic(event: DiagnosticEvent, user=Depends(identity)):
        logger.warning('browser_error code=%s at=%s request_id=%s status=%s',
                       event.code, event.at.isoformat(), event.requestId, event.status)
