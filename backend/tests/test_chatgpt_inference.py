import json
import time

import httpx
import pytest

from backend.agent import inference


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


@pytest.mark.asyncio
async def test_agent_turn_exposes_completed_function_call(monkeypatch):
    call = {'type': 'function_call', 'name': 'get_training_profile',
            'arguments': '{}', 'call_id': 'call-1'}
    def respond(request):
        if request.url.path == '/v1/models':
            return httpx.Response(200, json={'models': [{'slug': 'available', 'visibility': 'list'}]})
        body = json.loads(request.content)
        assert body['store'] is False and body['stream'] is True
        assert body['tools'][0]['name'] == 'get_training_profile'
        assert body['parallel_tool_calls'] is False
        assert body['input'] == [{'role': 'user', 'content': 'Explain my plan'}]
        event = {'type': 'response.completed', 'response': {'output': [call]}}
        return httpx.Response(200, text=f'data: {json.dumps(event)}\n\n')
    real = httpx.AsyncClient
    monkeypatch.setattr(inference.httpx, 'AsyncClient',
        lambda **kwargs: real(transport=httpx.MockTransport(respond)))
    result = await inference.complete_agent_turn('secret-access',
        [{'role': 'user', 'content': 'Explain my plan'}],
        [{'type': 'function', 'name': 'get_training_profile'}])
    assert result == {'output': [call], 'text': ''}


@pytest.mark.asyncio
async def test_agent_turn_reads_final_text_after_tool_output(monkeypatch):
    reply = {'type': 'message', 'content': [{'type': 'output_text', 'text': 'Follow your A/B plan.'}]}
    input_items = [{'role': 'user', 'content': 'Explain my plan'},
                   {'type': 'function_call', 'name': 'get_training_profile',
                    'arguments': '{}', 'call_id': 'call-1'},
                   {'type': 'function_call_output', 'call_id': 'call-1', 'output': '{"plan":"A/B"}'}]
    def respond(request):
        if request.url.path == '/v1/models':
            return httpx.Response(200, json={'models': [{'slug': 'available', 'visibility': 'list'}]})
        assert json.loads(request.content)['input'] == input_items
        event = {'type': 'response.completed', 'response': {'output': [reply]}}
        return httpx.Response(200, text=f'data: {json.dumps(event)}\n\n')
    real = httpx.AsyncClient
    monkeypatch.setattr(inference.httpx, 'AsyncClient',
        lambda **kwargs: real(transport=httpx.MockTransport(respond)))
    result = await inference.complete_agent_turn('secret-access', input_items, [])
    assert result == {'output': [reply], 'text': 'Follow your A/B plan.'}


@pytest.mark.asyncio
async def test_agent_turn_returns_refusal_text_instead_of_unsupported_reply(monkeypatch):
    refusal = {'type': 'message', 'content': [{'type': 'refusal', 'refusal': 'I can’t help with that request.'}]}
    def respond(request):
        if request.url.path == '/v1/models':
            return httpx.Response(200, json={'models': [{'slug': 'available', 'visibility': 'list'}]})
        event = {'type': 'response.completed', 'response': {'output': [refusal]}}
        return httpx.Response(200, text=f'data: {json.dumps(event)}\n\n')
    real = httpx.AsyncClient
    monkeypatch.setattr(inference.httpx, 'AsyncClient',
        lambda **kwargs: real(transport=httpx.MockTransport(respond)))
    result = await inference.complete_agent_turn('secret-access', [{'role': 'user', 'content': 'Help'}], [])
    assert result == {'output': [refusal], 'text': 'I can’t help with that request.'}


@pytest.mark.asyncio
async def test_agent_turn_uses_streamed_text_when_completion_omits_output(monkeypatch):
    def respond(request):
        if request.url.path == '/v1/models':
            return httpx.Response(200, json={'models': [{'slug': 'available', 'visibility': 'list'}]})
        return httpx.Response(200, text='data: {"type":"response.output_text.delta","delta":"Train today."}\n\n'
            'data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n')
    real = httpx.AsyncClient
    monkeypatch.setattr(inference.httpx, 'AsyncClient',
        lambda **kwargs: real(transport=httpx.MockTransport(respond)))
    result = await inference.complete_agent_turn('secret-access', [{'role': 'user', 'content': 'Help'}], [])
    assert result == {'output': [], 'text': 'Train today.'}


@pytest.mark.asyncio
async def test_agent_turn_uses_completed_stream_item_for_function_call(monkeypatch):
    call = {'type': 'function_call', 'name': 'get_training_profile', 'arguments': '{}', 'call_id': 'call-1'}
    def respond(request):
        if request.url.path == '/v1/models':
            return httpx.Response(200, json={'models': [{'slug': 'available', 'visibility': 'list'}]})
        item = {'type': 'response.output_item.done', 'output_index': 0, 'item': call}
        done = {'type': 'response.completed', 'response': {'status': 'completed', 'output': []}}
        return httpx.Response(200, text=f'data: {json.dumps(item)}\n\ndata: {json.dumps(done)}\n\n')
    real = httpx.AsyncClient
    monkeypatch.setattr(inference.httpx, 'AsyncClient',
        lambda **kwargs: real(transport=httpx.MockTransport(respond)))
    result = await inference.complete_agent_turn('secret-access', [{'role': 'user', 'content': 'My profile'}],
        [{'type': 'function', 'name': 'get_training_profile'}])
    assert result == {'output': [call], 'text': ''}


@pytest.mark.asyncio
async def test_agent_turn_retries_empty_completed_response_once(monkeypatch):
    attempts = 0
    def respond(request):
        nonlocal attempts
        if request.url.path == '/v1/models':
            return httpx.Response(200, json={'models': [{'slug': 'available', 'visibility': 'list'}]})
        attempts += 1
        body = json.loads(request.content)
        if attempts == 1:
            assert 'Produce a final text message' not in body['instructions']
            output = [{'type': 'reasoning', 'encrypted_content': 'opaque'}]
        else:
            assert 'Produce a final text message' in body['instructions']
            output = [{'type': 'message', 'content': [{'type': 'output_text', 'text': 'Start gently.'}]}]
        event = {'type': 'response.completed', 'response': {'status': 'completed', 'output': output}}
        return httpx.Response(200, text=f'data: {json.dumps(event)}\n\n')
    real = httpx.AsyncClient
    monkeypatch.setattr(inference.httpx, 'AsyncClient',
        lambda **kwargs: real(transport=httpx.MockTransport(respond)))
    result = await inference.complete_agent_turn('secret-access', [{'role': 'user', 'content': 'Help'}], [])
    assert result['text'] == 'Start gently.'
    assert attempts == 2


@pytest.mark.asyncio
async def test_agent_turn_rejects_incomplete_stream(monkeypatch):
    def respond(request):
        if request.url.path == '/v1/models':
            return httpx.Response(200, json={'models': [{'slug': 'available', 'visibility': 'list'}]})
        return httpx.Response(200, text='data: {"type":"response.output_text.delta","delta":"Partial"}\n\n')
    real = httpx.AsyncClient
    monkeypatch.setattr(inference.httpx, 'AsyncClient',
        lambda **kwargs: real(transport=httpx.MockTransport(respond)))
    with pytest.raises(inference.InferenceError) as error:
        await inference.complete_agent_turn('secret-access', [{'role': 'user', 'content': 'Hi'}], [])
    assert error.value.status == 502
