import pytest
from backend.testing.server import disposable_urls


@pytest.mark.parametrize('admin,runtime,ack', [
    ('postgresql+psycopg://admin@db.example/fitcoach_test', 'postgresql+psycopg://app@db.example/fitcoach_test', 'YES'),
    ('postgresql+psycopg://admin@127.0.0.1/production', 'postgresql+psycopg://app@127.0.0.1/production', 'YES'),
    ('postgresql+psycopg://admin@127.0.0.1/fitcoach_test', 'postgresql+psycopg://app@127.0.0.1:9999/fitcoach_test', 'YES'),
    ('postgresql+psycopg://admin@127.0.0.1/fitcoach_test', 'postgresql+psycopg://app@127.0.0.1/fitcoach_test', 'NO'),
])
def test_browser_harness_rejects_non_disposable_targets(monkeypatch, admin, runtime, ack):
    monkeypatch.setenv('FITCOACH_TEST_ADMIN_URL', admin)
    monkeypatch.setenv('FITCOACH_TEST_DATABASE_URL', runtime)
    monkeypatch.setenv('FITCOACH_TEST_ALLOW_RESET', ack)
    with pytest.raises(RuntimeError):
        disposable_urls()
