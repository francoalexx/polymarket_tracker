import express from "express";
import { normalizeWallet, isValidWallet } from "../shared/polymarket";
import { registerScannerRoutes } from "./scannerRoutes";
import { ScannerService } from "./scannerService";
import { StreamSession } from "./streamSession";

const PORT = Number(process.env.PORT ?? 5174);
const app = express();
const scannerService = new ScannerService();

scannerService.start();

app.use(express.json());
registerScannerRoutes(app, scannerService);

app.get("/api/health", (_request, response) => {
  response.json({
    ok: true,
    service: "bonereaper-polymarket-tracker",
    now: new Date().toISOString()
  });
});

app.get("/api/stream", (request, response) => {
  const wallet = normalizeWallet(String(request.query.wallet ?? ""));

  if (!isValidWallet(wallet)) {
    response.status(400).json({ error: "Invalid wallet address" });
    return;
  }

  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders();

  const session = new StreamSession(wallet, response);
  session.start();

  request.on("close", () => session.close());
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`Polymarket tracker API listening on http://127.0.0.1:${PORT}`);
});
