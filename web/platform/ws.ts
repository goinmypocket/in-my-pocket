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
  // Cache of the most recent push-style messages so a subscriber that
  // registers after the message arrived still sees the latest state.
  // Without this, the WS open event (server sends TABLES_LIST in the
  // same tick) races React's useEffect — the message is dispatched
  // before any React component has called subscribe(), so it's lost.
  private lastByType = new Map<ServerMessage["type"], ServerMessage>();

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
    // Replay the latest cached push messages so a late subscriber
    // (e.g. a React component whose useEffect ran after the WS open
    // event already delivered TABLES_LIST) doesn't miss them.
    for (const msg of this.lastByType.values()) {
      try {
        cb(msg);
      } catch {
        /* swallow — same as live dispatch */
      }
    }
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
      // Cache "latest" of the push types whose newest snapshot is
      // always sufficient. Per-table TABLE_STATE is keyed by type
      // alone here, but TableScreen filters by tableId so cross-talk
      // doesn't matter — the screen only renders state for its own
      // tableId.
      if (msg.type === "TABLES_LIST" || msg.type === "GAMES_LIST") {
        this.lastByType.set(msg.type, msg);
      }
      for (const cb of this.listeners) cb(msg);
    });

    ws.addEventListener("close", () => {
      this.setStatus("closed");
      this.ws = null;
      // Drop cached push messages — a fresh socket (potentially as a
      // different user after logout/login) should start clean.
      this.lastByType.clear();
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
