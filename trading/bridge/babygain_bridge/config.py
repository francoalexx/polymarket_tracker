from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def load_dotenv(path: Path = Path(".env")) -> None:
    if not path.exists():
        return

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


def env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "y", "on"}


def env_int(name: str, default: int) -> int:
    value = os.getenv(name)
    return default if value is None or value == "" else int(value)


@dataclass(frozen=True)
class BridgeConfig:
    dry_run: bool = True
    clob_host: str = "https://clob.polymarket.com"
    chain_id: int = 137
    private_key: str | None = None
    api_key: str | None = None
    api_secret: str | None = None
    api_passphrase: str | None = None
    signature_type: int | None = None
    funder_address: str | None = None

    @classmethod
    def from_env(cls) -> "BridgeConfig":
        load_dotenv()
        return cls(
            dry_run=env_bool("COPY_TRADER_DRY_RUN", True),
            clob_host=os.getenv("POLYMARKET_CLOB_HOST", "https://clob.polymarket.com"),
            chain_id=env_int("POLYMARKET_CHAIN_ID", 137),
            private_key=os.getenv("POLYMARKET_PRIVATE_KEY") or None,
            api_key=os.getenv("POLYMARKET_API_KEY") or None,
            api_secret=os.getenv("POLYMARKET_API_SECRET") or None,
            api_passphrase=os.getenv("POLYMARKET_API_PASSPHRASE") or None,
            signature_type=env_int("POLYMARKET_SIGNATURE_TYPE", 0),
            funder_address=os.getenv("POLYMARKET_FUNDER_ADDRESS") or None,
        )

    def validate_for_live(self) -> None:
        if self.dry_run:
            return
        if not self.private_key:
            raise ValueError("POLYMARKET_PRIVATE_KEY is required for live trading.")
        if self.signature_type in {1, 2, 3} and not self.funder_address:
            raise ValueError(
                f"POLYMARKET_FUNDER_ADDRESS is required when POLYMARKET_SIGNATURE_TYPE={self.signature_type}."
            )
