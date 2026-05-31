import os
from pathlib import Path
from typing import Literal

from dotenv import load_dotenv
from pydantic import Field
from pydantic_settings import BaseSettings

# Load .env file into os.environ so plugins can access all settings
env_file_path = os.environ.get("ENV_FILE", ".env")
load_dotenv(env_file_path, override=False)

Environment = Literal["development", "production"]
StorageType = Literal["local", "azure_blob"]


class Settings(BaseSettings):
    AUTH_ENABLED: bool = Field(env="AUTH_ENABLED", default=False)
    ADMIN_API_KEY: str = Field(env="ADMIN_API_KEY")
    PUBLIC_API_KEY: str = Field(env="PUBLIC_API_KEY")
    OPENAI_API_KEY: str = Field(env="OPENAI_API_KEY")
    GEMINI_API_KEY: str | None = Field(env="GEMINI_API_KEY", default=None)
    ENVIRONMENT: Environment = Field(env="ENVIRONMENT", default="production")

    # Next.jsのrevalidate API用の設定
    NEXT_PUBLIC_SITE_URL: str = Field(env="NEXT_PUBLIC_SITE_URL", default="http://localhost:3000")
    ADMIN_SITE_URL: str = Field(env="ADMIN_SITE_URL", default="http://localhost:4000")
    CORS_ALLOW_ORIGINS: str | None = Field(env="CORS_ALLOW_ORIGINS", default=None)
    REVALIDATE_SECRET: str = Field(env="REVALIDATE_SECRET", default="revalidate-secret")
    REVALIDATE_URL: str = Field(env="REVALIDATE_URL", default="http://public-viewer:3000/api/revalidate")
    BASE_DIR: Path = Path(__file__).parent.parent
    TOOL_DIR: Path = BASE_DIR / "broadlistening"
    REPORT_DIR: Path = Field(default=TOOL_DIR / "pipeline" / "outputs", env="REPORT_DIR")
    CONFIG_DIR: Path = Field(default=TOOL_DIR / "pipeline" / "configs", env="CONFIG_DIR")
    INPUT_DIR: Path = Field(default=TOOL_DIR / "pipeline" / "inputs", env="INPUT_DIR")
    DATA_DIR: Path = Field(default=BASE_DIR / "data", env="DATA_DIR")

    # ストレージ設定
    STORAGE_TYPE: StorageType = Field(env="STORAGE_TYPE", default="local")
    AZURE_BLOB_STORAGE_ACCOUNT_NAME: str | None = Field(env="AZURE_BLOB_STORAGE_ACCOUNT_NAME", default=None)
    AZURE_BLOB_STORAGE_CONTAINER_NAME: str | None = Field(env="AZURE_BLOB_STORAGE_CONTAINER_NAME", default=None)

    # Supabase Auth
    SUPABASE_URL: str | None = Field(env="SUPABASE_URL", default=None)
    SUPABASE_JWKS_URL: str | None = Field(env="SUPABASE_JWKS_URL", default=None)
    SUPABASE_JWT_ISSUER: str | None = Field(env="SUPABASE_JWT_ISSUER", default=None)
    SUPABASE_JWT_AUDIENCE: str = Field(env="SUPABASE_JWT_AUDIENCE", default="authenticated")
    SUPABASE_SERVICE_ROLE_KEY: str | None = Field(env="SUPABASE_SERVICE_ROLE_KEY", default=None)
    RETENTION_DAYS: int = Field(env="RETENTION_DAYS", default=30)

    @property
    def azure_blob_storage_account_url(self) -> str:
        return f"https://{self.AZURE_BLOB_STORAGE_ACCOUNT_NAME}.blob.core.windows.net"

    @property
    def cors_allow_origins(self) -> list[str]:
        configured_origins = [
            origin.strip() for origin in (self.CORS_ALLOW_ORIGINS or "").split(",") if origin.strip()
        ]
        default_origins = [
            self.NEXT_PUBLIC_SITE_URL,
            self.ADMIN_SITE_URL,
            "http://localhost:3000",
            "http://localhost:4000",
            "https://admin-production-6428.up.railway.app",
            "https://public-viewer-production-93b1.up.railway.app",
        ]
        return list(dict.fromkeys([*configured_origins, *default_origins]))

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        extra = "ignore"


env_file = os.environ.get("ENV_FILE", ".env")
settings = Settings(_env_file=env_file)
# レポート出力ツール側でOpenAI APIを利用できるように、環境変数にセットする
os.environ["OPENAI_API_KEY"] = settings.OPENAI_API_KEY
if settings.GEMINI_API_KEY:
    os.environ["GEMINI_API_KEY"] = settings.GEMINI_API_KEY
