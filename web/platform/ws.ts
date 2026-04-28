// Thin WS client that handles HELLO / ME_OK and exposes a typed send +
// subscribe surface. Reconnects on close with linear backoff.
import type {
  ClientMessage,
  ServerMessage,
  UserSummary,
} from "../../shared/platformProtocol";

type Status = "idle" | "connecting" | "open" | "closed";

export class PlatformClient {
  private ws: WebSocket | null = null;
  private listeners = new Set<(msg: ServerMessage) => void>();
  private statusListeners = new Set<(s: Status) => void>();
  private status: Status = "idle";
  private reconnectAttempt = 0;
  private wantOpen = false;
  private user: UserSummary | null = null;

  connect(): void {
    if (this.wantOpen) return;
    this.wantOpen = true;
    this.openSocket();
  }

  disconnect(): void {
    this.wantOpen = false;
    if (this.ws && this.ws.readyState === this.ws.OPEN) {
      this.ws.close();
    }
    this.ws = null;
  }

  send(msg: ClientMessage): void {
    if (this.ws && this.ws.readyState === this.ws.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      console.warn("[ws] send skipped (not open)", msg.type);
    }
  }

  subscribe(cb: (msg: ServerMessage) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  onStatus(cb: (s: Status) => void): () => void {
    cb(this.status);
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  }

  getUser(): UserSummary | null {
    return this.user;
  }

  private setStatus(s: Status): void {
    this.status = s;
    for (const cb of this.statusListeners) cb(s);
  }

  private openSocket(): void {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${location.host}/ws`;
    this.setStatus("connecting");
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.reconnectAttempt = 0;
      this.setStatus("open");
    });

    ws.addEventListener("message", (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(ev.data) as ServerMessage;
      } catch {
        return;
      }
      if (msg.type === "ME_OK") this.user = msg.user;
      for (const cb of this.listeners) cb(msg);
    });

    ws.addEventListener("close", () => {
      this.setStatus("closed");
      this.ws = null;
      if (this.wantOpen) {
        this.reconnectAttempt += 1;
        const delay = Math.min(1000 * this.reconnectAttempt, 8000);
        setTimeout(() => {
          if (this.wantOpen) this.openSocket();
        }, delay);
      }
    });

    ws.addEventListener("error", () => {
      // close handler will fire too; nothing to do here.
    });
  }
}
