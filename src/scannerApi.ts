import type { ScannerSnapshot } from "../shared/types";

export function connectScannerStream(onSnapshot: (snapshot: ScannerSnapshot) => void, onError: (message: string) => void): EventSource {
  const source = new EventSource("/api/scanner/stream");

  source.addEventListener("scanner_snapshot", (event) => {
    onSnapshot(JSON.parse((event as MessageEvent).data) as ScannerSnapshot);
  });

  source.onerror = () => onError("Scanner stream reconnecting");
  return source;
}

export async function confirmTicket(id: string): Promise<void> {
  const response = await fetch(`/api/tickets/${encodeURIComponent(id)}/confirm`, { method: "POST" });
  if (!response.ok) throw new Error(await response.text());
}

export async function cancelTicket(id: string): Promise<void> {
  const response = await fetch(`/api/tickets/${encodeURIComponent(id)}/cancel`, { method: "POST" });
  if (!response.ok) throw new Error(await response.text());
}
