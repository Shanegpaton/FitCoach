import os
from dataclasses import dataclass

from sqlalchemy.engine import make_url


def validate_url(value: str, allow_local_plaintext: bool = False) -> str:
    url = make_url(value)
    if url.drivername != 'postgresql+psycopg':
        raise ValueError('Use a postgresql+psycopg:// URL')
    local = url.host in ('localhost', '127.0.0.1', '::1')
    if not (local and allow_local_plaintext) and url.query.get('sslmode') not in ('require', 'verify-ca', 'verify-full'):
        raise ValueError('PostgreSQL requires TLS (sslmode=require or verify-full)')
    return value


@dataclass(frozen=True)
class Settings:
    database_url: str
    supabase_url: str
    supabase_key: str
    pool_size: int = 5
    pool_timeout: int = 10
    cors_origins: tuple[str, ...] = ()
    allow_local_plaintext: bool = False

    def __post_init__(self):
        validate_url(self.database_url, self.allow_local_plaintext)
        if not self.supabase_url.startswith('https://'):
            raise ValueError('Supabase Auth must use HTTPS')
        if not self.supabase_key:
            raise ValueError('Supabase publishable/anon key is required')
        if self.pool_size < 1 or self.pool_size > 100 or self.pool_timeout < 1:
            raise ValueError('Invalid database pool limits')

    @classmethod
    def from_env(cls):
        return cls(
            database_url=os.environ['FITCOACH_DATABASE_URL'],
            supabase_url=os.environ['FITCOACH_SUPABASE_URL'].rstrip('/'),
            supabase_key=os.environ['FITCOACH_SUPABASE_KEY'],
            # A function instance keeps its own pool; use one connection by default
            # on Vercel so scaling does not reserve five connections per instance.
            pool_size=int(os.getenv('FITCOACH_POOL_SIZE', '1' if os.getenv('VERCEL') else '5')),
            pool_timeout=int(os.getenv('FITCOACH_POOL_TIMEOUT', '10')),
            cors_origins=tuple(x.strip() for x in os.getenv('FITCOACH_CORS_ORIGINS', '').split(',') if x.strip()),
            allow_local_plaintext=os.getenv('FITCOACH_ALLOW_LOCAL_PLAINTEXT', 'false').lower() == 'true',
        )
