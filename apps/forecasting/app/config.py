from pydantic import BaseModel
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str = "postgres://sr_user:sr_password@postgres:5432/sr_groups"
    internal_service_token: str = "dev-internal-token"
    default_tax_rate: float = 0.18
    min_training_days: int = 7
    backtest_days: int = 14

    class Config:
        env_file = ".env"
        env_prefix = ""


class UserScope(BaseModel):
    user_id: int
    role: str
    shop_id: int | None = None


settings = Settings()
