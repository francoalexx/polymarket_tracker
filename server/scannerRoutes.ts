import type { Express } from "express";
import type { ExecutionLogEntry, PreparedTradeTicket, ScannerSnapshot } from "../shared/types";
import type { ScannerService } from "./scannerService";
import { PythonTradingProvider, executionFromProviderResponse, type TradingProvider } from "./tradingProvider";

export function scannerEventPayload(snapshot: ScannerSnapshot): string {
  return `event: scanner_snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`;
}

export function registerScannerRoutes(
  app: Express,
  scanner: ScannerService,
  tradingProvider: TradingProvider = new PythonTradingProvider()
): void {
  app.get("/api/scanner/stream", (request, response) => {
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.flushHeaders();

    const unsubscribe = scanner.subscribe((snapshot) => {
      response.write(scannerEventPayload(snapshot));
    });

    request.on("close", unsubscribe);
  });

  app.get("/api/candidates", (_request, response) => {
    response.json(scanner.getSnapshot());
  });

  app.get("/api/trading/status", (_request, response) => {
    response.json(tradingProvider.status());
  });

  app.post("/api/tickets/:id/cancel", (request, response) => {
    const ticket = scanner.cancelTicket(request.params.id);
    if (!ticket) {
      response.status(404).json({ error: "Ticket not found" });
      return;
    }
    response.json(ticket);
  });

  app.post("/api/tickets/:id/confirm", async (request, response) => {
    try {
      const result = await confirmTicket(scanner, tradingProvider, request.params.id);
      if (!result) {
        response.status(404).json({ error: "Ticket not found" });
        return;
      }
      response.json(result);
    } catch (error) {
      response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}

export async function confirmTicket(
  scanner: ScannerService,
  tradingProvider: TradingProvider,
  id: string
): Promise<{ ticket: PreparedTradeTicket; execution: ExecutionLogEntry } | undefined> {
  const ticket = scanner.getSnapshot().tickets.find((candidate) => candidate.id === id && candidate.status === "pending");
  if (!ticket) return undefined;

  ticket.status = "confirmed";
  let result;
  try {
    result = await tradingProvider.submit(ticket);
  } catch (error) {
    ticket.status = "rejected";
    scanner.recordExecution({
      id: `execution:${ticket.id}:${Date.now()}`,
      ticketId: ticket.id,
      status: "error",
      message: error instanceof Error ? error.message : String(error),
      createdAt: Date.now()
    });
    throw error;
  }
  const execution = executionFromProviderResponse(ticket, result);

  if (execution.status === "error" || execution.status === "rejected") {
    ticket.status = "rejected";
  } else {
    scanner.markTicketSubmitted(ticket.id);
  }

  scanner.recordExecution(execution);
  return { ticket, execution };
}
