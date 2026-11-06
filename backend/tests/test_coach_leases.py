"""Lease task lifecycle checks that need no PostgreSQL service."""
import asyncio
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from backend import conversations as turns


@pytest.mark.asyncio
async def test_heartbeat_loss_cancels_work_and_restores_context(monkeypatch):
    monkeypatch.setattr(turns, 'HEARTBEAT_SECONDS', 0.001)
    renew = AsyncMock(side_effect=RuntimeError('Database unavailable'))
    monkeypatch.setattr(turns, 'renew_turn', renew)
    ids = [uuid4() for _ in range(4)]
    with pytest.raises(RuntimeError, match='Database unavailable'):
        async with turns.processing_turn(object(), *ids):
            assert turns.current_attempt.get() == tuple(ids[1:])
            await asyncio.sleep(1)
    assert turns.current_attempt.get() is None
    assert renew.await_count == 1


@pytest.mark.asyncio
async def test_execution_deadline_cancels_work(monkeypatch):
    monkeypatch.setattr(turns, 'EXECUTION_SECONDS', 0.001)
    with pytest.raises(asyncio.TimeoutError):
        async with turns.processing_turn(object(), *(uuid4() for _ in range(4))):
            await asyncio.sleep(1)
    assert turns.current_attempt.get() is None


@pytest.mark.asyncio
async def test_normal_completion_stops_heartbeat(monkeypatch):
    renew = AsyncMock()
    monkeypatch.setattr(turns, 'renew_turn', renew)
    async with turns.processing_turn(object(), *(uuid4() for _ in range(4))):
        pass
    assert turns.current_attempt.get() is None
    renew.assert_not_awaited()


@pytest.mark.asyncio
async def test_request_cancellation_stops_heartbeat(monkeypatch):
    renew = AsyncMock()
    monkeypatch.setattr(turns, 'renew_turn', renew)
    entered = asyncio.Event()

    async def request():
        async with turns.processing_turn(object(), *(uuid4() for _ in range(4))):
            entered.set()
            await asyncio.sleep(10)

    task = asyncio.create_task(request())
    await entered.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    renew.assert_not_awaited()
    assert turns.current_attempt.get() is None
