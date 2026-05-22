import { spawn } from "node:child_process";
import type { ExecutionLogEntry, PreparedTradeTicket } from "../shared/types";

export type TradingProviderResponse = {
  status: string;
  message: string;
  ticket?: unknown;
  response?: unknown;
};

export type TradingProviderStatus = {
  mode: "dry_run" | "live";
  ready: boolean;
  message: string;
};

export type TradingProvider = {
  status(): TradingProviderStatus;
  submit(ticket: PreparedTradeTicket): Promise<TradingProviderResponse>;
};

export function buildTradingProviderCommand(): { command: string; args: string[] } {
  return {
    command: process.env.PYTHON_BIN ?? "python3",
    args: ["trading/bridge/execute_ticket.py"]
  };
}

export function parseTradingProviderResponse(raw: string): TradingProviderResponse {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || typeof parsed.status !== "string" || typeof parsed.message !== "string") {
      throw new Error("Missing status or message");
    }
    return parsed as TradingProviderResponse;
  } catch (error) {
    throw new Error(`Invalid trading bridge response: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export class PythonTradingProvider implements TradingProvider {
  status(): TradingProviderStatus {
    if (process.env.COPY_TRADER_DRY_RUN !== "false") {
      return { mode: "dry_run", ready: true, message: "Trading bridge is in dry-run mode." };
    }

    if (!process.env.POLYMARKET_PRIVATE_KEY) {
      return {
        mode: "live",
        ready: false,
        message: "POLYMARKET_PRIVATE_KEY is required for live trading."
      };
    }

    return { mode: "live", ready: true, message: "Trading bridge is configured for live trading." };
  }

  submit(ticket: PreparedTradeTicket): Promise<TradingProviderResponse> {
    const command = buildTradingProviderCommand();
    const payload = JSON.stringify({
      id: ticket.id,
      token_id: ticket.asset,
      side: ticket.kind === "entry" ? "BUY" : "SELL",
      price: ticket.limitPrice,
      size: ticket.size,
      tick_size: ticket.market.minTickSize,
      neg_risk: ticket.market.negRisk,
      expires_at: ticket.expiresAt
    });

    return new Promise((resolve, reject) => {
      const child = spawn(command.command, command.args, { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("close", () => {
        try {
          resolve(parseTradingProviderResponse(stdout.trim()));
        } catch (error) {
          const stderrSuffix = stderr.trim() ? ` ${stderr.trim()}` : "";
          reject(
            new Error(
              `${error instanceof Error ? error.message : String(error)}${stderrSuffix}`
            )
          );
        }
      });

      child.stdin.end(payload);
    });
  }
}

export function executionFromProviderResponse(
  ticket: PreparedTradeTicket,
  result: TradingProviderResponse
): ExecutionLogEntry {
  return {
    id: `execution:${ticket.id}:${Date.now()}`,
    ticketId: ticket.id,
    status: executionStatus(result.status),
    message: result.message,
    response: result.response,
    createdAt: Date.now()
  };
}

function executionStatus(status: string): ExecutionLogEntry["status"] {
  if (status === "dry_run" || status === "submitted") return status;
  if (status === "rejected") return "rejected";
  return "error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
