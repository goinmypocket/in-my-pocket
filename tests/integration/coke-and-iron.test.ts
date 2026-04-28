// =============================================================================
// End-to-end test: register the real coke-and-iron module, sign two users
// up, create a table, claim seats, set identities via game protocol,
// start the game, observe SNAPSHOT broadcasts.
// =============================================================================
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import type {
  ClientMessage,
  ServerMessage,
} from "../../shared/platformProtocol";
import { generateInviteCode } from "../../platform/auth/inviteCodes";
import { openDb } from "../../platform/db/client";
import * as invitesDb from "../../platform/db/invites";
import { buildRegistry } from "../../platform/games/registry";
import { startPlatform, type RunningPlatform } from "../../platform/server";

const INVITE_A = generateInviteCode();
const INVITE_B = generateInviteCode();

let dataDir: string;
let server: RunningPlatform;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "imp-cnci-"));
  const reg = await buildRegistry();
  if (reg.size === 0) {
    throw new Error("registry empty — coke-and-iron file: link missing?");
  }
  server = await startPlatform({ port: 0, dataDir });

  const db = openDb(dataDir);
  invitesDb.insertInvite(db, { code: INVITE_A, maxUses: 1 });
  invitesDb.insertInvite(db, { code: INVITE_B, maxUses: 1 });
  db.close();
});

afterAll(async () => {
  await server.close();
  rmSync(dataDir, { recursive: true, force: true });
});

interface AuthedSession {
  cookie: string;
  userId: string;
  username: string;
}

async function signup(
  username: string,
  inviteCode: string,
): Promise<AuthedSession> {
  const res = await fetch(`http://localhost:${server.port}/api/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: "password123", inviteCode }),
  });
  if (!res.ok) throw new Error(`signup failed: ${await res.text()}`);
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("no Set-Cookie");
  const cookie = setCookie.split(";")[0]!;
  const body = (await res.json()) as { user: { id: string; username: string } };
  return { cookie, userId: body.user.id, username: body.user.username };
}

interface WsHandle {
  ws: WebSocket;
  msgs: ServerMessage[];
  send(msg: ClientMessage): void;
  waitFor(predicate: (m: ServerMessage) => boolean, timeoutMs?: number): Promise<ServerMessage>;
  close(): Promise<void>;
}

function openWs(cookie: string): Promise<WsHandle> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${server.port}/ws`, {
      headers: { Cookie: cookie },
    });
    const msgs: ServerMessage[] = [];
    const pending: Array<{
      predicate: (m: ServerMessage) => boolean;
      resolve: (m: ServerMessage) => void;
      timer: NodeJS.Timeout;
    }> = [];
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString()) as ServerMessage;
      msgs.push(msg);
      for (let i = pending.length - 1; i >= 0; i--) {
        if (pending[i]!.predicate(msg)) {
          clearTimeout(pending[i]!.timer);
          pending[i]!.resolve(msg);
          pending.splice(i, 1);
        }
      }
    });
    ws.on("open", () =>
      resolve({
        ws,
        msgs,
        send(msg) {
          ws.send(JSON.stringify(msg));
        },
        waitFor(predicate, timeoutMs = 3000) {
          const existing = msgs.find(predicate);
          if (existing) return Promise.resolve(existing);
          return new Promise<ServerMessage>((res, rej) => {
            const timer = setTimeout(() => {
              const idx = pending.findIndex((p) => p.timer === timer);
              if (idx >= 0) pending.splice(idx, 1);
              rej(new Error("waitFor timeout"));
            }, timeoutMs);
            pending.push({ predicate, resolve: res, timer });
          });
        },
        close() {
          return new Promise<void>((res) => {
            ws.once("close", () => res());
            ws.close();
          });
        },
      }),
    );
    ws.on("error", reject);
  });
}

describe("coke-and-iron via the platform", () => {
  it("registry registers the game", async () => {
    const reg = await buildRegistry();
    expect(reg.has("coke-and-iron" as never)).toBe(true);
  });

  it("LIST_GAMES reports coke-and-iron with options schema", async () => {
    const alice = await signup("ci-alice", INVITE_A);
    const ws = await openWs(alice.cookie);
    await ws.waitFor((m) => m.type === "ME_OK");
    ws.send({ type: "LIST_GAMES" });
    const games = await ws.waitFor((m) => m.type === "GAMES_LIST");
    if (games.type !== "GAMES_LIST") throw new Error("expected GAMES_LIST");
    const g = games.games.find((x) => x.id === "coke-and-iron");
    expect(g).toBeDefined();
    expect(g!.minPlayers).toBe(2);
    expect(g!.maxPlayers).toBe(4);
    const keys = g!.optionsSchema.map((f) => f.key).sort();
    expect(keys).toEqual(["allowUndo", "autoEndTurn", "seed"]);
    await ws.close();
  });

  it("create → join → start with auto-identity → intent broadcasts to both", async () => {
    // Mint two invites for this run.
    const db = openDb(dataDir);
    const codeA = generateInviteCode();
    const codeB = generateInviteCode();
    invitesDb.insertInvite(db, { code: codeA, maxUses: 1 });
    invitesDb.insertInvite(db, { code: codeB, maxUses: 1 });
    db.close();

    const alice = await signup("auto-alice", codeA);
    const bob = await signup("auto-bob", codeB);
    const aliceWs = await openWs(alice.cookie);
    const bobWs = await openWs(bob.cookie);
    await aliceWs.waitFor((m) => m.type === "ME_OK");
    await bobWs.waitFor((m) => m.type === "ME_OK");

    aliceWs.send({
      type: "CREATE_TABLE",
      gameId: "coke-and-iron" as never,
      name: "Auto-identity table",
      isPrivate: false,
      options: { seed: 7, autoEndTurn: false, allowUndo: true },
    });
    const created = await aliceWs.waitFor((m) => m.type === "TABLE_STATE");
    if (created.type !== "TABLE_STATE") throw new Error("expected TABLE_STATE");
    const tableId = created.table.id;

    bobWs.send({ type: "JOIN_TABLE", tableId, seatIndex: 1, kind: "player" });
    await bobWs.waitFor((m) => m.type === "TABLE_STATE");

    // Start without sending SET_SEAT_IDENTITY — the platform's
    // username should auto-fill into displayName.
    aliceWs.msgs.length = 0;
    bobWs.msgs.length = 0;
    aliceWs.send({ type: "START_GAME", tableId });

    const aliceSnap = await aliceWs.waitFor(
      (m) =>
        m.type === "GAME_MSG_OUT" &&
        (m.payload as { type?: string }).type === "SNAPSHOT",
    );
    if (aliceSnap.type !== "GAME_MSG_OUT")
      throw new Error("expected SNAPSHOT");
    const aliceEnv = (aliceSnap.payload as { playing: { viewerPlayerId: number } })
      .playing;
    expect(aliceEnv.viewerPlayerId).toBe(0);

    const bobSnap = await bobWs.waitFor(
      (m) =>
        m.type === "GAME_MSG_OUT" &&
        (m.payload as { type?: string }).type === "SNAPSHOT",
    );
    if (bobSnap.type !== "GAME_MSG_OUT") throw new Error("expected SNAPSHOT");
    const bobEnv = (bobSnap.payload as { playing: { viewerPlayerId: number } })
      .playing;
    expect(bobEnv.viewerPlayerId).toBe(1);

    await aliceWs.close();
    await bobWs.close();
  });

  it("create → claim → set identity → start emits SNAPSHOT to both seats", async () => {
    const alice = await signup("ci-bob", INVITE_B);
    const aliceWs = await openWs(alice.cookie);
    await aliceWs.waitFor((m) => m.type === "ME_OK");

    aliceWs.send({
      type: "CREATE_TABLE",
      gameId: "coke-and-iron" as never,
      name: "Test C&I",
      isPrivate: false,
      options: { seed: 7, autoEndTurn: false, allowUndo: true },
    });
    const tableMsg = await aliceWs.waitFor((m) => m.type === "TABLE_STATE");
    if (tableMsg.type !== "TABLE_STATE") throw new Error("expected TABLE_STATE");
    const tableId = tableMsg.table.id;
    // Host auto-claimed seat 0.
    expect(tableMsg.table.slots[0]?.claimedBy?.username).toBe("ci-bob");

    // Game LOBBY_STATE arrives via GAME_MSG_OUT to Alice (the only attached user).
    const lobbyHello = await aliceWs.waitFor((m) => m.type === "GAME_MSG_OUT");
    if (lobbyHello.type !== "GAME_MSG_OUT")
      throw new Error("expected GAME_MSG_OUT");
    expect((lobbyHello.payload as { type: string }).type).toBe("LOBBY_STATE");

    // Set host's seat identity.
    aliceWs.send({
      type: "GAME_MSG",
      tableId,
      payload: {
        type: "SET_SEAT_IDENTITY",
        slotIndex: 0,
        displayName: "Alice",
        pawnColor: "red",
      },
    });

    // We need a 2nd user. Sign up another and have them claim slot 1.
    // First mint another invite via the DB.
    const db = openDb(dataDir);
    const code = generateInviteCode();
    invitesDb.insertInvite(db, { code, maxUses: 1 });
    db.close();
    const carol = await signup("ci-carol", code);
    const carolWs = await openWs(carol.cookie);
    await carolWs.waitFor((m) => m.type === "ME_OK");
    carolWs.send({
      type: "JOIN_TABLE",
      tableId,
      seatIndex: 1,
      kind: "player",
    });
    await carolWs.waitFor((m) => m.type === "TABLE_STATE");
    carolWs.send({
      type: "GAME_MSG",
      tableId,
      payload: {
        type: "SET_SEAT_IDENTITY",
        slotIndex: 1,
        displayName: "Carol",
        pawnColor: "blue",
      },
    });

    // Host starts the game.
    aliceWs.msgs.length = 0;
    carolWs.msgs.length = 0;
    aliceWs.send({ type: "START_GAME", tableId });

    // Both players should receive a SNAPSHOT (carried in GAME_MSG_OUT).
    const aliceSnap = await aliceWs.waitFor(
      (m) =>
        m.type === "GAME_MSG_OUT" &&
        (m.payload as { type?: string }).type === "SNAPSHOT",
    );
    const carolSnap = await carolWs.waitFor(
      (m) =>
        m.type === "GAME_MSG_OUT" &&
        (m.payload as { type?: string }).type === "SNAPSHOT",
    );
    if (aliceSnap.type !== "GAME_MSG_OUT")
      throw new Error("expected SNAPSHOT for alice");
    if (carolSnap.type !== "GAME_MSG_OUT")
      throw new Error("expected SNAPSHOT for carol");

    await aliceWs.close();
    await carolWs.close();
  });
});
