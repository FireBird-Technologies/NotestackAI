from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    env: str = "development"
    app_name: str = "Notestack"
    frontend_url: str = "http://localhost:5173"
    api_url: str = "http://localhost:8000"
    cors_origins: str = "http://localhost:5173"

    database_url: str = "postgresql+psycopg://notestack:notestack@localhost:5432/notestack"
    redis_url: str = "redis://localhost:6379/0"

    # Auth
    jwt_secret: str = "change-me"
    jwt_algorithm: str = "HS256"
    jwt_expiration_hours: int = 72
    jwt_refresh_expiration_days: int = 30
    google_client_id: str = ""

    # Email (Resend)
    email_provider: str = "console"  # resend | console
    resend_api_key: str = ""
    from_email: str = "Notestack <hello@notestack.ai>"
    alerts_email: str = "arslan@firebird-technologies.com"
    unsubscribe_secret: str = "change-me-too"
    update_email_send_hour: int = 9

    # Storage (Cloudflare R2, S3 compatible)
    r2_account_id: str = ""
    r2_access_key_id: str = ""
    r2_secret_access_key: str = ""
    r2_bucket: str = "notestack-assets"
    r2_endpoint_url: str = ""  # override for MinIO locally; defaults to the R2 account endpoint
    r2_public_base_url: str = ""  # optional custom domain for public objects
    r2_presign_ttl_seconds: int = 3600
    max_upload_bytes: int = 200 * 1024 * 1024

    # LLM (LiteLLM model strings; Z.ai GLM by default)
    llm_model: str = "openai/glm-5.3"
    llm_fast_model: str = "openai/glm-5.3-flash"
    llm_api_base: str = "https://api.z.ai/api/paas/v4"
    llm_api_key: str = ""
    llm_temperature: float = 1.0  # Z.ai recommends 1.0 for GLM-5.x
    # Reasoning output counts against max_tokens, so leave headroom for the structured answer.
    llm_max_tokens: int = 16000
    # GLM-5.x always reasons (it cannot be disabled); this sets how hard. low | high | max
    llm_reasoning_effort: str = "low"

    # Corpus: posts as markdown files. R2 is the source of truth; each process keeps a disk cache.
    corpus_cache_dir: str = ".corpus-cache"
    research_max_steps: int = 10

    # ElevenLabs
    elevenlabs_api_key: str = ""

    # Renderer
    renderer_url: str = "http://localhost:3100"
    internal_token: str = "internal-change-me"

    # Billing
    billing_enabled: bool = False

    @property
    def r2_endpoint(self) -> str:
        if self.r2_endpoint_url:
            return self.r2_endpoint_url
        return f"https://{self.r2_account_id}.r2.cloudflarestorage.com"

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
