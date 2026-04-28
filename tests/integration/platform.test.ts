// =============================================================================
// End-to-end smoke test: HTTP signup → cookie → WS auth → create table →
// second user joins as spectator → state broadcasts → leave.
//
// Uses a stub GameDefinition registered into the registry via test-only
// monkey-patching of the registry build output.
// =============================================================================
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import type {
  GameDefinition,
  GameSession,
} from "../../shared/GameDefinition";
import type { GameId, UserId } from "../../shared/ids";
import { asGameId } from "../../shared/ids";
import type { ServerMessage } from "../../shared/platformProtocol";
import { generateInviteCode } from "../../platform/auth/inviteCodes";
import { openDb } from "../../platform/db/client";
import * as invitesDb from "../../platform/db/invites";
import { startPlatform, type RunningPlatform } from "../../platform/server";

// ---------------------------------------------------------------------------
// Stub game
// ---------------------------------------------------------------------------

const STUB_ID = asGameId("stub-game");

function makeStubDef(): GameDefinition {
  return {
    id: STUB_ID,
    displayName: "Stub Game",
    minPlayers: 1,
    maxPlayers: 4,
    supportsSpectators: true,
    optionsSchema: [],
    createSession: () => makeStubSession(),
    loadSession: () => makeStubSession(),
  };
}

function makeStubSession(): GameSession {
  const seats = new Map<number, UserId>();
  let status: "lobby" | "playing" | "finished" = "lobby";
  return {
    attachConnection: () => {},
    detachConnection: () => {},
    claimSeat: (userId, seatIndex) => {
      seats.set(seatIndex, userId);
      return { ok: true };
    },
    releaseSeat: (_userId, seatIndex) => {
      seats.delete(seatIndex);
      return { ok: true };
    },
    kickSeat: (_caller, seatIndex) => {
      seats.delete(seatIndex);
      return { ok: true };
    },
    startGame: () => {
      status = "playing";
      return { ok: true };
    },
    handleGameMessage: () => {},
    serialize: () => ({ stub: true }),
    describe: () => ({
      status,
      playerCount: seats.size,
      maxPlayers: 4,
      spectatorCount: 0,
      lastActivityAt: Date.now(),
    }),
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

// Pre-generated codes so the test is deterministic.
const TEST_INVITE_CODE = generateInviteCode();
const TEST_INVITE_CODE_2 = generateInviteCode();

let dataDir: string;
let server: RunningPlatform;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "imp-test-"));
  server = await startPlatform({
    port: 0,
    dataDir,
    registryOverride: new Map<GameId, GameDefinition>([[STUB_ID, makeStubDef()]]),
  });

  // Mint invites directly via the DB so signups have something to redeem.
  const db = openDb(dataDir);
  invitesDb.insertInvite(db, { code: TEST_INVITE_CODE, maxUses: 5 });
  invitesDb.insertInvite(db, { code: TEST_INVITE_CODE_2, maxUses: 5 });
  db.close();
});

afterAll(async () => {
  await server.close();
  rmSync(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  if (!res.ok) {
    throw new Error(`signup failed: ${res.status} ${await res.text()}`);
  }
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("no Set-Cookie on signup");
  const cookie = setCookie.split(";")[0]!;
  const body = (await res.json()) as { user: { id: string; username: string } };
  return { cookie, userId: body.user.id, username: body.user.username };
}

interface WSHandle {
  ws: WebSocket;
  msgs: ServerMessage[];
  waitFor(predicate: (m: ServerMessage) => boolean, timeoutMs?: number): Promise<ServerMessage>;
  close(): Promise<void>;
}

function openWs(cookie: string): Promise<WSHandle> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${server.port}/ws`, {
      headers: { Cookie: cookie },
    });
    const msgs: ServerMessage[] = [];
    const pending: Array<{
      predicate: (m: ServerMessage) => boolean;
      resolve: (m: ServerMessage) => void;
      reject: (e: Error) => void;
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
    ws.on("open", () => {
      resolve({
        ws,
        msgs,
        waitFor(predicate, timeoutMs = 2000) {
          // Already received?
          const existing = msgs.find(predicate);
          if (existing) return Promise.resolve(existing);
          return new Promise<ServerMessage>((res, rej) => {
            const timer = setTimeout(() => {
              const idx = pending.findIndex((p) => p.timer === timer);
              if (idx >= 0) pending.splice(idx, 1);
              rej(new Error("waitFor timeout"));
            }, timeoutMs);
            pending.push({ predicate, resolve: res, reject: rej, timer });
          });
        },
        close() {
          return new Promise<void>((res) => {
            ws.once("close", () => res());
            ws.close();
          });
        },
      });
    });
    ws.on("error", reject);
  });
}

function send(ws: WebSocket, msg: unknown): void {
  ws.send(JSON.stringify(msg));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("platform end-to-end", () => {
  it("signup → ws hello → me_ok", async () => {
    const alice = await signup("alice", TEST_INVITE_CODE);
    const handle = await openWs(alice.cookie);
    const hello = await handle.waitFor((m) => m.type === "HELLO");
    expect(hello.type).toBe("HELLO");
    const me = await handle.waitFor((m) => m.type === "ME_OK");
    if (me.type !== "ME_OK") throw new Error("expected ME_OK");
    expect(me.user?.username).toBe("alice");
    await handle.close();
  });

  it("create table → second user joins as spectator → leaves", async () => {
    const alice = await signup("alice2", TEST_INVITE_CODE);
    const bob = await signup("bob", TEST_INVITE_CODE_2);

    const aliceWs = await openWs(alice.cookie);
    const bobWs = await openWs(bob.cookie);
    await aliceWs.waitFor((m) => m.type === "ME_OK");
    await bobWs.waitFor((m) => m.type === "ME_OK");

    send(aliceWs.ws, {
      type: "CREATE_TABLE",
      gameId: STUB_ID,
      name: "Test Table",
      isPrivate: false,
      options: {},
    });

    const tableMsg = await aliceWs.waitFor((m) => m.type === "TABLE_STATE");
    if (tableMsg.type !== "TABLE_STATE") throw new Error("expected TABLE_STATE");
    expect(tableMsg.table.hostUserId).toBe(alice.userId);
    expect(tableMsg.table.slots[0]?.claimedBy?.username).toBe("alice2");
    const tableId = tableMsg.table.id;

    // Bob joins as spectator. Both Alice and Bob should see the updated state.
    send(bobWs.ws, {
      type: "JOIN_TABLE",
      tableId,
      seatIndex: -1,
      kind: "spectator",
    });
    const aliceUpdate = await aliceWs.waitFor(
      (m) => m.type === "TABLE_STATE" && m.table.id === tableId && aliceWs.msgs.indexOf(m) > 0,
      3000,
    );
    if (aliceUpdate.type !== "TABLE_STATE") throw new Error("expected TABLE_STATE");
    expect(aliceUpdate.table.id).toBe(tableId);

    const bobUpdate = await bobWs.waitFor((m) => m.type === "TABLE_STATE");
    if (bobUpdate.type !== "TABLE_STATE") throw new Error("expected TABLE_STATE");
    expect(bobUpdate.table.id).toBe(tableId);

    // Bob leaves.
    send(bobWs.ws, { type: "LEAVE_TABLE", tableId });

    // Spectator gone — Alice should see another TABLE_STATE update.
    const afterLeave = await aliceWs.waitFor(
      (m) =>
        m.type === "TABLE_STATE" &&
        m.table.id === tableId &&
        aliceWs.msgs.filter((x) => x.type === "TABLE_STATE").length >= 3,
      3000,
    );
    expect(afterLeave.type).toBe("TABLE_STATE");

    await aliceWs.close();
    await bobWs.close();
  });

  it("rejects ws upgrade without cookie", async () => {
    const ws = new WebSocket(`ws://localhost:${server.port}/ws`);
    const result = await new Promise<string>((resolve) => {
      ws.on("error", (err) => resolve(err.message));
      ws.on("open", () => resolve("opened"));
    });
    expect(result).not.toBe("opened");
  });
});
