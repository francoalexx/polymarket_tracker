from __future__ import annotations

import json
import math
import os
import re
import sys
from dataclasses import asdict
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from babygain_bridge.config import BridgeConfig
from babygain_bridge.trader import BridgeTicket, BridgeTrader


SENSITIVE_ENV_NAMES = (
    "POLYMARKET_PRIVATE_KEY",
    "POLYMARKET_API_KEY",
    "POLYMARKET_API_SECRET",
    "POLYMARKET_API_PASSPHRASE",
)
MAX_ERROR_MESSAGE_LENGTH = 2_000
MAX_EXPIRES_AT = 4_102_444_800


def sanitize_error(message: str) -> str:
    sanitized = message
    for name in SENSITIVE_ENV_NAMES:
        value = os.getenv(name)
        if value:
            sanitized = sanitized.replace(value, "[REDACTED_SECRET]")
        sanitized = re.sub(rf"\b{re.escape(name)}\b", "[REDACTED_KEY]", sanitized)
    if len(sanitized) > MAX_ERROR_MESSAGE_LENGTH:
        return f"{sanitized[:MAX_ERROR_MESSAGE_LENGTH]} [error truncated]"
    return sanitized


def build_ticket(payload: Any) -> BridgeTicket:
    if not isinstance(payload, dict):
        raise ValueError("Bridge payload must be a JSON object.")

    side = require_string(payload, "side")
    if side not in {"BUY", "SELL"}:
        raise ValueError("side must be exactly BUY or SELL.")

    neg_risk = payload.get("neg_risk")
    if not isinstance(neg_risk, bool):
        raise ValueError("neg_risk must be a JSON boolean.")

    price = require_finite_float(payload, "price")
    if not 0 < price < 1:
        raise ValueError("price must be finite and greater than 0 and less than 1.")

    size = require_finite_float(payload, "size")
    if size <= 0:
        raise ValueError("size must be finite and greater than 0.")

    tick_size = require_finite_float(payload, "tick_size")
    if tick_size <= 0:
        raise ValueError("tick_size must be finite and greater than 0.")

    expires_at = payload.get("expires_at")
    if isinstance(expires_at, bool) or not isinstance(expires_at, int):
        raise ValueError("expires_at must be an integer timestamp.")
    if expires_at <= 0 or expires_at > MAX_EXPIRES_AT:
        raise ValueError("expires_at must be a sane positive Unix timestamp.")

    return BridgeTicket(
        id=require_string(payload, "id"),
        token_id=require_string(payload, "token_id"),
        side=side,
        price=price,
        size=size,
        tick_size=tick_size,
        neg_risk=neg_risk,
        expires_at=expires_at,
    )


def require_string(payload: dict[str, Any], key: str) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or value == "":
        raise ValueError(f"{key} must be a non-empty string.")
    return value


def require_finite_float(payload: dict[str, Any], key: str) -> float:
    value = payload.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{key} must be a JSON number.")
    parsed = float(value)
    if not math.isfinite(parsed):
        raise ValueError(f"{key} must be finite.")
    return parsed


def main() -> int:
    try:
        config = BridgeConfig.from_env()
        payload = json.loads(sys.stdin.read())
        ticket = build_ticket(payload)
        config.validate_for_live()
        response = BridgeTrader(config).submit(ticket)
        status = "dry_run" if config.dry_run else "submitted"
        print(json.dumps({"status": status, "message": "ok", "ticket": asdict(ticket), "response": response}, sort_keys=True))
        return 0
    except Exception as exc:
        print(json.dumps({"status": "error", "message": sanitize_error(str(exc))}, sort_keys=True))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
