from functools import lru_cache
from typing import Any

from fastapi import HTTPException, Security
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from fastapi.security.api_key import APIKeyHeader
from pydantic import BaseModel

from src.config import settings

api_key_header = APIKeyHeader(name="x-api-key", auto_error=False)
bearer_scheme = HTTPBearer(auto_error=False)
api_key_security = Security(api_key_header)
bearer_security = Security(bearer_scheme)


class CurrentUser(BaseModel):
    user_id: str
    email: str | None = None
    claims: dict[str, Any]


@lru_cache
def _get_jwks_client():
    if not settings.SUPABASE_JWKS_URL:
        raise HTTPException(status_code=500, detail="SUPABASE_JWKS_URL is not configured")

    try:
        from jwt import PyJWKClient
    except ImportError as e:  # pragma: no cover - dependency is only required when AUTH_ENABLED=true
        raise HTTPException(status_code=500, detail="PyJWT[crypto] is not installed") from e

    return PyJWKClient(settings.SUPABASE_JWKS_URL)


async def get_current_user(credentials: HTTPAuthorizationCredentials | None = bearer_security) -> CurrentUser:
    if not settings.AUTH_ENABLED:
        return CurrentUser(user_id="local-development", claims={})

    if credentials is None or credentials.scheme.lower() != "bearer":
        raise HTTPException(status_code=401, detail="Bearer token required")

    return _decode_current_user(credentials.credentials)


async def get_optional_current_user(
    credentials: HTTPAuthorizationCredentials | None = bearer_security,
) -> CurrentUser | None:
    if not settings.AUTH_ENABLED:
        return CurrentUser(user_id="local-development", claims={})

    if credentials is None or credentials.scheme.lower() != "bearer":
        return None

    return _decode_current_user(credentials.credentials)


def _decode_current_user(token: str) -> CurrentUser:
    try:
        import jwt

        signing_key = _get_jwks_client().get_signing_key_from_jwt(token)
        issuer = settings.SUPABASE_JWT_ISSUER or (
            f"{settings.SUPABASE_URL.rstrip('/')}/auth/v1" if settings.SUPABASE_URL else None
        )
        decode_options = {"verify_aud": bool(settings.SUPABASE_JWT_AUDIENCE)}
        claims = jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256", "ES256"],
            audience=settings.SUPABASE_JWT_AUDIENCE,
            issuer=issuer,
            options=decode_options,
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=401, detail="Invalid bearer token") from e

    user_id = claims.get("sub")
    if not user_id:
        raise HTTPException(status_code=401, detail="Invalid bearer token")

    return CurrentUser(user_id=user_id, email=claims.get("email"), claims=claims)


current_user_security = Security(get_current_user)


async def verify_admin_api_key(
    api_key: str | None = api_key_security,
    current_user: CurrentUser = current_user_security,
) -> str:
    if not api_key or api_key != settings.ADMIN_API_KEY:
        raise HTTPException(status_code=401, detail="Invalid API key")
    return api_key


async def verify_public_api_key(
    api_key: str | None = api_key_security,
    current_user: CurrentUser = current_user_security,
) -> str:
    if not api_key or api_key != settings.PUBLIC_API_KEY:
        raise HTTPException(status_code=401, detail="Invalid API key")
    return api_key
