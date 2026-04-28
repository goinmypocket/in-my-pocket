// Per-user fanout. The platform owns a Map<UserId, Set<WebSocket>>; the
// session never sees individual sockets — it calls `sendToUser`, the
// platform broadcasts to every socket the user has open.
import type { WebSocket } from "ws";
import type { UserId } from "../../shared/ids";
import type { ServerMessage } from "../../shared/platformProtocol";

export class ConnectionRegistry {
  private byUser = new Map<UserId, Set<WebSocket>>();

  add(userId: UserId, ws: WebSocket): void {
    let set = this.byUser.get(userId);
    if (!set) {
      set = new Set();
      this.byUser.set(userId, set);
    }
    set.add(ws);
  }

  remove(userId: UserId, ws: WebSocket): void {
    const set = this.byUser.get(userId);
    if (!set) return;
    set.delete(ws);
    if (set.size === 0) this.byUser.delete(userId);
  }

  countSockets(userId: UserId): number {
    return this.byUser.get(userId)?.size ?? 0;
  }

  isOnline(userId: UserId): boolean {
    return this.countSockets(userId) > 0;
  }

  /** Snapshot of every userId that currently has at least one open
   *  socket. Order is insertion-order. */
  getOnlineUsers(): UserId[] {
    return [...this.byUser.keys()];
  }

  sendToUser(userId: UserId, msg: ServerMessage): void {
    const set = this.byUser.get(userId);
    if (!set) return;
    const text = JSON.stringify(msg);
    for (const ws of set) {
      if (ws.readyState === ws.OPEN) ws.send(text);
    }
  }

  broadcastToUsers(userIds: Iterable<UserId>, msg: ServerMessage): void {
    const text = JSON.stringify(msg);
    for (const userId of userIds) {
      const set = this.byUser.get(userId);
      if (!set) continue;
      for (const ws of set) {
        if (ws.readyState === ws.OPEN) ws.send(text);
      }
    }
  }
}
