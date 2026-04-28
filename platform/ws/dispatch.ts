// =============================================================================
// Dispatch a parsed ClientMessage to the right TableManager method, then
// respond on the originating socket if needed. The TableManager handles
// broadcast-to-many; only point-to-point replies (LIST_*, errors) are
// sent here.
// =============================================================================
import type { WebSocket } from "ws";
import type { UserId } from "../../shared/ids";
import { asGameId, asSaveId, asTableId } from "../../shared/ids";
import type {
  ClientMessage,
  ServerMessage,
} from "../../shared/platformProtocol";
import type { TableManager } from "../tables/TableManager";

export function dispatchMessage(
  ws: WebSocket,
  userId: UserId,
  msg: ClientMessage,
  tableManager: TableManager,
): void {
  const reply = (m: ServerMessage): void => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
  };
  const fail = (reason: string, cause?: string): void => {
    reply(cause !== undefined ? { type: "ERROR", reason, cause } : { type: "ERROR", reason });
  };

  switch (msg.type) {
    case "LIST_GAMES": {
      reply({ type: "GAMES_LIST", games: tableManager.listGames() });
      return;
    }

    case "CREATE_TABLE": {
      const result = tableManager.createTable({
        hostUserId: userId,
        gameId: asGameId(msg.gameId),
        name: msg.name,
        isPrivate: msg.isPrivate,
        options: msg.options,
      });
      if (!result.ok) return fail(result.reason);
      const state = tableManager.getTableState(result.tableId);
      if (state) reply({ type: "TABLE_STATE", table: state });
      return;
    }

    case "LIST_TABLES": {
      const tables = tableManager.listTables({
        viewerUserId: userId,
        ...(msg.filter?.gameId !== undefined ? { gameId: asGameId(msg.filter.gameId) } : {}),
        ...(msg.filter?.status !== undefined ? { status: msg.filter.status } : {}),
        ...(msg.filter?.mineOnly !== undefined ? { mineOnly: msg.filter.mineOnly } : {}),
      });
      reply({ type: "TABLES_LIST", tables });
      return;
    }

    case "JOIN_TABLE": {
      const result = tableManager.joinTable(
        userId,
        asTableId(msg.tableId),
        msg.seatIndex,
        msg.kind,
      );
      if (!result.ok) return fail(result.reason);
      return;
    }

    case "LEAVE_TABLE": {
      tableManager.leaveTable(userId, asTableId(msg.tableId));
      return;
    }

    case "KICK_USER": {
      const result = tableManager.kickUser(
        userId,
        asTableId(msg.tableId),
        msg.seatIndex,
      );
      if (!result.ok) fail(result.reason);
      return;
    }

    case "START_GAME": {
      const result = tableManager.startGame(userId, asTableId(msg.tableId));
      if (!result.ok) fail(result.reason);
      return;
    }

    case "DELETE_TABLE": {
      const result = tableManager.deleteTable(userId, asTableId(msg.tableId));
      if (!result.ok) fail(result.reason);
      return;
    }

    case "SAVE_TABLE": {
      const result = tableManager.saveTable(
        userId,
        asTableId(msg.tableId),
        msg.name,
      );
      if (!result.ok) return fail(result.reason);
      const saves = tableManager.listSavesForUser(userId);
      reply({ type: "SAVES_LIST", saves });
      return;
    }

    case "LIST_SAVES": {
      reply({ type: "SAVES_LIST", saves: tableManager.listSavesForUser(userId) });
      return;
    }

    case "LOAD_TABLE": {
      const result = tableManager.loadTableFromSave({
        saveId: asSaveId(msg.saveId),
        hostUserId: userId,
        name: msg.name,
        isPrivate: msg.isPrivate,
      });
      if (!result.ok) return fail(result.reason);
      const state = tableManager.getTableState(result.tableId);
      if (state) reply({ type: "TABLE_STATE", table: state });
      return;
    }

    case "DELETE_SAVE": {
      tableManager.deleteSave(userId, asSaveId(msg.saveId));
      reply({ type: "SAVES_LIST", saves: tableManager.listSavesForUser(userId) });
      return;
    }

    case "GAME_MSG": {
      tableManager.routeGameMsg(userId, asTableId(msg.tableId), msg.payload);
      return;
    }
  }
}

export function parseClientMessage(raw: string): ClientMessage | null {
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object" || typeof obj.type !== "string")
      return null;
    return obj as ClientMessage;
  } catch {
    return null;
  }
}
