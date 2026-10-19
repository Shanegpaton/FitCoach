"""Encrypted VM-to-API ChatGPT credential handoff; never serialize tokens to the PWA."""
import base64
import hashlib
import json
import os
import re
from urllib.parse import urlsplit

import httpx
from cryptography.fernet import Fernet

ISSUER = 'https://auth.openai.com'


def handoff_secret() -> str:
    secret = os.environ.get('FITCOACH_CHATGPT_SECRET', '')
    if not re.fullmatch(r'[A-Za-z0-9_-]{43}', secret) or len(base64.urlsafe_b64decode(secret + '=')) != 32:
        raise ValueError('FITCOACH_CHATGPT_SECRET must be a 32-byte base64url secret')
    return secret


def vm_origin() -> str:
    value = os.environ.get('FITCOACH_CHATGPT_VM_ORIGIN', '')
    parsed = urlsplit(value)
    if (parsed.scheme != 'https' or not parsed.netloc or parsed.path or parsed.query or parsed.fragment
            or parsed.username or parsed.password):
        raise ValueError('FITCOACH_CHATGPT_VM_ORIGIN must be an HTTPS origin')
    return value


def vault() -> Fernet:
    material = hashlib.sha256(b'fitcoach-chatgpt-vault-v1:' + handoff_secret().encode()).digest()
    return Fernet(base64.urlsafe_b64encode(material))


def validate_record(payload: dict, user_id: str) -> dict:
    if payload.get('userId') != user_id or not isinstance(payload.get('credentials'), dict):
        raise ValueError('Handoff account mismatch')
    record = payload['credentials']
    if record.get('issuer') != ISSUER:
        raise ValueError('Invalid ChatGPT issuer')
    for key in ('access_token', 'refresh_token', 'id_token', 'client_id', 'subject', 'ext_agent_host_id'):
        if not isinstance(record.get(key), str) or not record[key]:
            raise ValueError('Incomplete ChatGPT credential record')
    if not isinstance(record.get('scopes'), list) or not all(isinstance(x, str) for x in record['scopes']):
        raise ValueError('Invalid granted scopes')
    if not {'openid', 'profile', 'email', 'offline_access'}.issubset(record['scopes']):
        raise ValueError('Required identity or renewal scope is missing')
    if not isinstance(record.get('plan_usage_granted'), bool) or record['plan_usage_granted'] != (
            'chatgpt.tokens.use.direct' in record['scopes']):
        raise ValueError('Invalid plan permission')
    if not isinstance(record.get('expires_at'), int):
        raise ValueError('Invalid token expiry')
    for key in ('email', 'name'):
        if record.get(key) is not None and not isinstance(record[key], str):
            raise ValueError('Invalid verified account label')
    if len(json.dumps(record, separators=(',', ':'))) > 32768:
        raise ValueError('Credential record is too large')
    return record


def encrypt_record(record: dict) -> bytes:
    return vault().encrypt(json.dumps(record, separators=(',', ':')).encode())


def decrypt_record(ciphertext: bytes) -> dict:
    return json.loads(vault().decrypt(ciphertext))


async def revoke_record(record: dict) -> bool:
    try:
        async with httpx.AsyncClient(timeout=10, follow_redirects=False) as client:
            metadata = await client.get(f'{ISSUER}/.well-known/openid-configuration')
            metadata.raise_for_status()
            endpoint = metadata.json().get('revocation_endpoint', '')
            parsed = urlsplit(endpoint)
            if parsed.scheme != 'https' or parsed.netloc != 'auth.openai.com' or parsed.username or parsed.password:
                return False
            response = await client.post(endpoint, data={'token': record['refresh_token'],
                'token_type_hint': 'refresh_token', 'client_id': record['client_id']})
            return response.status_code == 200
    except (httpx.HTTPError, KeyError, ValueError):
        return False
