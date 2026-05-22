import { spawn } from "node:child_process";
import type { ExecutionLogEntry, PreparedTradeTicket } from "../shared/types";

const SENSITIVE_ENV_NAMES = [
  "POLYMARKET_PRIVATE_KEY",
  "POLYMARKET_API_KEY",
  "POLYMARKET_API_SECRET",
  "POLYMARKET_API_PASSPHRASE"
];
const BRIDGE_TIMEOUT_MS = 10_000;
const BRIDGE_KILL_GRACE_MS = 500;
const MAX_OUTPUT_BYTES = 256 * 1024;
const STDERR_MESSAGE_LIMIT = 2_000;

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

export type PythonTradingProviderOptions = {
  timeoutMs?: number;
  killGraceMs?: number;
  maxOutputBytes?: number;
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
    return sanitizeTradingProviderValue(parsed) as TradingProviderResponse;
  } catch (error) {
    throw new Error(`Invalid trading bridge response: ${sanitizeTradingProviderText(error instanceof Error ? error.message : String(error))}`);
  }
}

export function sanitizeTradingProviderText(text: string): string {
  let sanitized = text;
  for (const name of SENSITIVE_ENV_NAMES) {
    const value = process.env[name];
    if (value) {
      sanitized = sanitized.split(value).join("[REDACTED_SECRET]");
    }
    sanitized = sanitized.replace(new RegExp(`\\b${escapeRegExp(name)}\\b`, "g"), "[REDACTED_KEY]");
  }
  return sanitized;
}

export class PythonTradingProvider implements TradingProvider {
  private readonly timeoutMs: number;
  private readonly killGraceMs: number;
  private readonly maxOutputBytes: number;

  constructor(options: PythonTradingProviderOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? BRIDGE_TIMEOUT_MS;
    this.killGraceMs = options.killGraceMs ?? BRIDGE_KILL_GRACE_MS;
    this.maxOutputBytes = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;
  }

  status(): TradingProviderStatus {
    if (process.env.COPY_TRADER_DRY_RUN !== "false") {
      return { mode: "dry_run", ready: true, message: "Trading bridge is in dry-run mode." };
    }

    if (!process.env.POLYMARKET_PRIVATE_KEY) {
      return {
        mode: "live",
        ready: false,
        message: "Private key is required for live trading."
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
      let settled = false;
      let killGrace: ReturnType<typeof setTimeout> | undefined;
      const timeout = setTimeout(() => {
        resolveGuard("Trading bridge timed out.");
      }, this.timeoutMs);

      const settle = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (killGrace) clearTimeout(killGrace);
        callback();
      };

      const stopRetainingOutput = () => {
        child.stdout.off("data", onStdoutData);
        child.stderr.off("data", onStderrData);
        child.stdout.pause();
        child.stderr.pause();
        child.stdout.destroy();
        child.stderr.destroy();
      };

      const cleanupChild = () => {
        if (child.killed || child.exitCode !== null || child.signalCode !== null) return;
        child.kill("SIGTERM");
        killGrace = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
          }
        }, this.killGraceMs);
        killGrace.unref?.();
      };

      const resolveGuard = (message: string) => {
        settle(() => {
          stopRetainingOutput();
          cleanupChild();
          resolve({ status: "error", message });
        });
      };

      const onStdoutData = (chunk: string) => {
        if (settled) return;
        const next = appendWithinLimit(stdout, chunk, this.maxOutputBytes);
        stdout = next.value;
        if (next.exceeded) {
          resolveGuard("Trading bridge stdout exceeded output limit.");
        }
      };
      const onStderrData = (chunk: string) => {
        if (settled) return;
        const next = appendWithinLimit(stderr, chunk, this.maxOutputBytes);
        stderr = next.value;
        if (next.exceeded) {
          resolveGuard("Trading bridge stderr exceeded output limit.");
        }
      };

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", onStdoutData);
      child.stderr.on("data", onStderrData);
      child.on("error", (error) => {
        settle(() => reject(new Error(sanitizeTradingProviderText(error.message))));
      });
      child.on("close", (code, signal) => {
        settle(() => {
          const raw = stdout.trim();
          const stderrMessage = stderr.trim() ? ` ${truncateStderr(stderr)}` : "";
          let parsed: TradingProviderResponse;

          try {
            parsed = parseTradingProviderResponse(raw);
          } catch (error) {
            reject(
              new Error(
                `${error instanceof Error ? error.message : String(error)}${stderrMessage}`
              )
            );
            return;
          }

          if (signal && parsed.status !== "error") {
            resolve({
              ...parsed,
              status: "error",
              message: sanitizeTradingProviderText(`Trading bridge terminated by signal ${signal}: ${parsed.message}`)
            });
            return;
          }

          if (code && code !== 0 && parsed.status !== "error") {
            resolve({
              ...parsed,
              status: "error",
              message: sanitizeTradingProviderText(`Trading bridge exited with code ${code}: ${parsed.message}`)
            });
            return;
          }

          resolve(parsed);
        });
      });

      child.stdin.end(payload);
    });
  }
}

function appendWithinLimit(current: string, chunk: string, maxBytes: number): { value: string; exceeded: boolean } {
  const available = maxBytes - Buffer.byteLength(current, "utf8");
  if (available <= 0) return { value: current, exceeded: true };

  const chunkBytes = Buffer.byteLength(chunk, "utf8");
  if (chunkBytes <= available) return { value: current + chunk, exceeded: false };

  return { value: current + Buffer.from(chunk).subarray(0, available).toString("utf8"), exceeded: true };
}

export function executionFromProviderResponse(
  ticket: PreparedTradeTicket,
  result: TradingProviderResponse
): ExecutionLogEntry {
  return {
    id: `execution:${ticket.id}:${Date.now()}`,
    ticketId: ticket.id,
    status: executionStatus(result.status),
    message: sanitizeTradingProviderText(result.message),
    response: sanitizeTradingProviderValue(result.response),
    createdAt: Date.now()
  };
}

function sanitizeTradingProviderValue(value: unknown): unknown {
  if (typeof value === "string") return sanitizeTradingProviderText(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeTradingProviderValue(item));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [sanitizeTradingProviderText(key), sanitizeTradingProviderValue(entry)])
    );
  }
  return value;
}

function truncateStderr(stderr: string): string {
  const sanitized = sanitizeTradingProviderText(stderr.trim());
  if (sanitized.length <= STDERR_MESSAGE_LIMIT) return sanitized;
  return `${sanitized.slice(0, STDERR_MESSAGE_LIMIT)} [stderr truncated]`;
}

function executionStatus(status: string): ExecutionLogEntry["status"] {
  if (status === "dry_run" || status === "submitted") return status;
  if (status === "rejected") return "rejected";
  return "error";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
