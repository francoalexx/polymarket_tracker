from __future__ import annotations

import json
import sys
from dataclasses import asdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from babygain_bridge.config import BridgeConfig
from babygain_bridge.trader import BridgeTicket, BridgeTrader


def main() -> int:
    try:
        payload = json.loads(sys.stdin.read())
        config = BridgeConfig.from_env()
        config.validate_for_live()
        ticket = BridgeTicket(
            id=str(payload["id"]),
            token_id=str(payload["token_id"]),
            side=str(payload["side"]).upper(),
            price=float(payload["price"]),
            size=float(payload["size"]),
            tick_size=float(payload["tick_size"]),
            neg_risk=bool(payload["neg_risk"]),
            expires_at=int(payload["expires_at"]),
        )
        response = BridgeTrader(config).submit(ticket)
        status = "dry_run" if config.dry_run else "submitted"
        print(json.dumps({"status": status, "message": "ok", "ticket": asdict(ticket), "response": response}, sort_keys=True))
        return 0
    except Exception as exc:
        print(json.dumps({"status": "error", "message": str(exc)}, sort_keys=True))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
