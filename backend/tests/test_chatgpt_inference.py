import json
import time

import httpx
import pytest

from backend import chatgpt_inference as inference


@pytest.mark.asyncio
async def test_refresh_rotates_both_tokens_and_uses_issued_client(monkeypatch):
    actual = []
    def respond(request):
        actual.append(request)
        return httpx.Response(200, json={'access_token': 'new-access', 'refresh_token': 'new-refresh',
            'expires_in': 3600, 'scope': 'openid offline_access resource.invoke chatgpt.tokens.use.direct'})
    real = httpx.AsyncClient
    monkeypatch.setattr(inference.httpx, 'AsyncClient',
        lambda **kwargs: real(transport=httpx.MockTransport(respond)))
    record = {'client_id': 'issued-client', 'refresh_token': 'old-refresh', 'id_token': 'old-id'}
    result = await inference.refresh_record(record)
    assert result['access_token'] == 'new-access'
    assert result['refresh_token'] == 'new-refresh'
    assert result['id_token'] == 'old-id'
    assert result['expires_at'] > time.time() + 3500
    assert b'client_id=issued-client' in actual[0].content
    assert b'old-refresh' in actual[0].content
    assert b'resource=https%3A%2F%2Fapi.openai.com%2Fv1' in actual[0].content


@pytest.mark.asyncio
async def test_completed_stream_only_and_required_request_fields(monkeypatch):
    def respond(request):
        if request.url.path == '/v1/models':
            return httpx.Response(200, json={'models': [
                {'slug': 'hidden', 'visibility': 'hidden'}, {'slug': 'available', 'visibility': 'list'}]})
        assert request.headers['Authorization'] == 'Bearer secret-access'
        body = json.loads(request.content)
        assert body['model'] == 'available'
        assert body['store'] is False and body['stream'] is True
        assert body['input'] == [{'role': 'user', 'content': 'Help me train'}]
        return httpx.Response(200, text='data: {"type":"response.output_text.delta","delta":"Train "}\n\n'
            'data: {"type":"response.output_text.delta","delta":"today."}\n\n'
            'data: {"type":"response.completed"}\n\n')
    real = httpx.AsyncClient
    monkeypatch.setattr(inference.httpx, 'AsyncClient',
        lambda **kwargs: real(transport=httpx.MockTransport(respond)))
    assert await inference.complete_response('secret-access',
        [{'role': 'user', 'text': 'Help me train'}], '') == 'Train today.'


@pytest.mark.asyncio
async def test_failed_stream_never_returns_partial_reply(monkeypatch):
    def respond(request):
        if request.url.path == '/v1/models':
            return httpx.Response(200, json={'models': [{'slug': 'available', 'visibility': 'list'}]})
        return httpx.Response(200, text='data: {"type":"response.output_text.delta","delta":"Partial"}\n\n'
            'data: {"type":"response.failed","response":{"error":{"code":"subscription_sharing_usage_limit_exceeded"}}}\n\n')
    real = httpx.AsyncClient
    monkeypatch.setattr(inference.httpx, 'AsyncClient',
        lambda **kwargs: real(transport=httpx.MockTransport(respond)))
    with pytest.raises(inference.InferenceError) as error:
        await inference.complete_response('secret-access', [{'role': 'user', 'text': 'Help'}], '')
    assert error.value.status == 429
