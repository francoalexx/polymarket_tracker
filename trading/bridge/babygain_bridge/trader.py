from __future__ import annotations

import inspect
from dataclasses import asdict, dataclass
from typing import Any

from .config import BridgeConfig


@dataclass(frozen=True)
class BridgeTicket:
    id: str
    token_id: str
    side: str
    price: float
    size: float
    tick_size: float
    neg_risk: bool
    expires_at: int


def supported_kwargs(callable_obj: Any, kwargs: dict[str, Any]) -> dict[str, Any]:
    try:
        signature = inspect.signature(callable_obj)
    except (TypeError, ValueError):
        return kwargs
    if any(parameter.kind == inspect.Parameter.VAR_KEYWORD for parameter in signature.parameters.values()):
        return kwargs
    return {key: value for key, value in kwargs.items() if key in signature.parameters}


def construct(cls: Any, **kwargs: Any) -> Any:
    return cls(**supported_kwargs(cls, kwargs))


class BridgeTrader:
    def __init__(self, config: BridgeConfig):
        self.config = config
        self._client: tuple[Any, dict[str, Any]] | None = None

    def submit(self, ticket: BridgeTicket) -> dict[str, Any]:
        if self.config.dry_run:
            return {"dry_run": True, "ticket": asdict(ticket)}

        client, models = self._get_client_and_models()
        side = ticket.side.upper()
        if side not in {"BUY", "SELL"}:
            raise ValueError("BridgeTicket.side must be BUY or SELL.")

        order_args = construct(
            models["OrderArgs"],
            token_id=ticket.token_id,
            price=ticket.price,
            side=models["Side"].BUY if side == "BUY" else models["Side"].SELL,
            size=ticket.size,
            expiration=ticket.expires_at,
        )
        order_options = construct(
            models["PartialCreateOrderOptions"],
            tick_size=str(ticket.tick_size),
            neg_risk=ticket.neg_risk,
        )
        order_type = getattr(models["OrderType"], "GTD", getattr(models["OrderType"], "GTC", None))

        try:
            response = client.create_and_post_order(order_args, order_options, order_type)
        except Exception as exc:
            message = str(exc)
            if "maker address not allowed" in message or "deposit wallet flow" in message:
                raise RuntimeError(
                    "Polymarket rejected this as a direct maker order. Set "
                    "POLYMARKET_SIGNATURE_TYPE=3 and POLYMARKET_FUNDER_ADDRESS to your "
                    "Polymarket deposit wallet address, then make sure that deposit wallet "
                    "holds the funds and has trading approvals."
                ) from exc
            if "order signer address has to be the address of the API KEY" in message:
                raise RuntimeError(
                    "Polymarket rejected the order because the request's CLOB API identity "
                    "still does not match the deposit-wallet order signer. Confirm "
                    "POLYMARKET_SIGNATURE_TYPE=3, POLYMARKET_FUNDER_ADDRESS is the actual "
                    "Polymarket deposit wallet, and POLYMARKET_API_KEY/SECRET/PASSPHRASE "
                    "are blank or generated for that same wallet setup."
                ) from exc
            raise

        return {"dry_run": False, "ticket": asdict(ticket), "response": response}

    def _get_client_and_models(self) -> tuple[Any, dict[str, Any]]:
        if self._client is not None:
            return self._client

        try:
            from py_clob_client_v2 import ApiCreds, ClobClient, OrderArgs, OrderType, PartialCreateOrderOptions, Side
        except ImportError as exc:
            raise RuntimeError(
                "Live trading requires py-clob-client-v2. Install it with: python -m pip install -r trading/requirements.txt"
            ) from exc

        creds = None
        if self.config.api_key and self.config.api_secret and self.config.api_passphrase:
            creds = construct(
                ApiCreds,
                api_key=self.config.api_key,
                api_secret=self.config.api_secret,
                api_passphrase=self.config.api_passphrase,
            )

        client_kwargs = {
            "host": self.config.clob_host,
            "chain_id": self.config.chain_id,
            "key": self.config.private_key,
            "creds": creds,
            "signature_type": self.config.signature_type,
            "signatureType": self.config.signature_type,
            "funder": self.config.funder_address,
            "funder_address": self.config.funder_address,
            "funderAddress": self.config.funder_address,
            "use_server_time": True,
        }
        client_kwargs = {key: value for key, value in client_kwargs.items() if value is not None}
        client = ClobClient(**supported_kwargs(ClobClient, client_kwargs))

        if creds is None:
            if not hasattr(client, "create_or_derive_api_key"):
                raise RuntimeError("CLOB client cannot derive API creds; set POLYMARKET_API_* values in .env.")
            client.set_api_creds(client.create_or_derive_api_key())

        self._client = (
            client,
            {
                "OrderArgs": OrderArgs,
                "OrderType": OrderType,
                "PartialCreateOrderOptions": PartialCreateOrderOptions,
                "Side": Side,
            },
        )
        return self._client
