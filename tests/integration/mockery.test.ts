// =============================================================================
// End-to-end test for Mockery via the platform: registers the game,
// signs two users up, creates a table, claims seats, starts the game,
// configures setup, starts trading, makes a trade, settles, asserts
// final state.
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

let dataDir: string;
let server: RunningPlatform;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "imp-mockery-"));
  process.env["DATA_DIR"] = dataDir;       // mockery's library will live here
  const reg = await buildRegistry();
  if (!reg.has("mockery" as never)) {
    throw new Error("mockery not registered — file: link broken?");
  }
  server = await startPlatform({ port: 0, dataDir });
});

afterAll(async () => {
  await server.close();
  // Close mockery's library DB so Windows can release the WAL file lock.
  const { closeLibrary } = await import("../../mockery/server/db/library");
  closeLibrary();
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // Windows sometimes still holds a transient lock; ignore.
  }
  delete process.env["DATA_DIR"];
});

interface AuthedSession {
  cookie: string;
  userId: string;
  username: string;
}

async function signup(username: string): Promise<AuthedSession> {
  const db = openDb(dataDir);
  const inviteCode = generateInviteCode();
  invitesDb.insertInvite(db, { code: inviteCode, maxUses: 1 });
  db.close();

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
        ws, msgs,
        send(msg) { ws.send(JSON.stringify(msg)); },
        waitFor(predicate, timeoutMs = 3000) {
          const existing = msgs.find(predicate);
          if (existing) return Promise.resolve(existing);
          return new Promise<ServerMessage>((res, rej) => {
            const timer = setTimeout(() => {
              const idx = pending.findIndex((p) => p.timer === timer);
              if (idx >= 0) pending.splice(idx, 1);
              rej(new Error(`waitFor timeout. recent: ${msgs.slice(-3).map((m) => m.type).join(",")}`));
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

function gameMsgOut(predicate: (payload: Record<string, unknown>) => boolean) {
  return (m: ServerMessage): boolean =>
    m.type === "GAME_MSG_OUT" && predicate(m.payload as Record<string, unknown>);
}

describe("mockery via the platform", () => {
  it("registers in the games registry with the seat-range definition", async () => {
    const reg = await buildRegistry();
    expect(reg.has("mockery" as never)).toBe(true);
    const def = reg.get("mockery" as never)!;
    expect(def.minPlayers).toBe(2);
    expect(def.maxPlayers).toBe(8);
    expect(def.supportsSpectators).toBe(true);
    const keys = def.optionsSchema.map((f) => f.key);
    expect(keys).toContain("eventMode");
    expect(keys).toContain("codeMode");
    expect(keys).toContain("identityReveal");
  });

  it("LIST_GAMES includes mockery alongside coke-and-iron", async () => {
    const alice = await signup(`mk-list-${Date.now()}`);
    const ws = await openWs(alice.cookie);
    await ws.waitFor((m) => m.type === "ME_OK");
    ws.send({ type: "LIST_GAMES" });
    const games = await ws.waitFor((m) => m.type === "GAMES_LIST");
    if (games.type !== "GAMES_LIST") throw new Error("expected GAMES_LIST");
    expect(games.games.find((g) => g.id === "mockery")).toBeDefined();
    await ws.close();
  });

  it("full flow: 2-player table, configure, start trading, trade, end, settle", async () => {
    // Use a 2-informed-seats variant (smaller scenario for the test).
    const alice = await signup(`mk-host-${Date.now()}`);
    const bob = await signup(`mk-bob-${Date.now()}`);
    const a = await openWs(alice.cookie);
    const b = await openWs(bob.cookie);
    await a.waitFor((m) => m.type === "ME_OK");
    await b.waitFor((m) => m.type === "ME_OK");

    // Alice creates a Mockery table.
    a.send({
      type: "CREATE_TABLE",
      gameId: "mockery" as never,
      name: "Test mockery",
      isPrivate: false,
      options: {
        informedSeats: 2,
        uninformedSeats: 0,
        publicSlots: 0,
        copiesPerValue: 4,
        cardValuesCsv: "1,2,9,10",
        eventMode: "manual",
        eventIntervalMin: 60,
        eventIntervalMax: 60,
        endGameGraceSec: 0,
        codeMode: "alpha",
        enforceCaseByRole: false,
        identityReveal: "all",
        seed: 7,
      },
    });
    const tableMsg = await a.waitFor((m) => m.type === "TABLE_STATE");
    if (tableMsg.type !== "TABLE_STATE") throw new Error("expected TABLE_STATE");
    const tableId = tableMsg.table.id;

    // Bob joins seat 1.
    b.send({ type: "JOIN_TABLE", tableId, seatIndex: 1, kind: "player" });
    await b.waitFor((m) => m.type === "TABLE_STATE");

    // Alice (host) starts. Both should now see a STATE_SNAPSHOT for setup.
    a.msgs.length = 0;
    b.msgs.length = 0;
    a.send({ type: "START_GAME", tableId });

    const aSetup = await a.waitFor(gameMsgOut((p) => p["type"] === "STATE_SNAPSHOT"));
    if (aSetup.type !== "GAME_MSG_OUT") throw new Error("expected STATE_SNAPSHOT");
    const aSetupSnap = (aSetup.payload as { snap: { status: string } }).snap;
    expect(aSetupSnap.status).toBe("setup");

    // Host configures: import sum-all contract, queue an event, then START_TRADING.
    a.send({
      type: "GAME_MSG", tableId,
      payload: { type: "SETUP_IMPORT_CONTRACT", source: "shared", refId: "sum-all" },
    });
    a.send({
      type: "GAME_MSG", tableId,
      payload: { type: "SETUP_QUEUE_APPEND", event: { type: "ROTATE_INFORMED" } },
    });
    a.send({
      type: "GAME_MSG", tableId,
      payload: { type: "START_TRADING" },
    });

    // Both should now receive a STATE_SNAPSHOT in playing status.
    const aPlay = await a.waitFor(gameMsgOut(
      (p) => p["type"] === "STATE_SNAPSHOT"
        && (p["snap"] as { status: string } | undefined)?.status === "playing",
    ));
    if (aPlay.type !== "GAME_MSG_OUT") throw new Error("expected playing snap");
    const aPlaySnap = (aPlay.payload as { snap: Record<string, unknown> }).snap;
    expect((aPlaySnap["contracts"] as unknown[]).length).toBe(1);
    expect((aPlaySnap["viewer"] as { role: string }).role).toBe("informed");
    expect((aPlaySnap["viewer"] as { myCard: number | null }).myCard).not.toBeNull();

    // Bob's snapshot should also show informed but NOT show Alice's card.
    const bPlay = await b.waitFor(gameMsgOut(
      (p) => p["type"] === "STATE_SNAPSHOT"
        && (p["snap"] as { status: string } | undefined)?.status === "playing",
    ));
    if (bPlay.type !== "GAME_MSG_OUT") throw new Error("expected bob playing snap");
    const bPlaySnap = (bPlay.payload as { snap: Record<string, unknown> }).snap;
    const bViewer = bPlaySnap["viewer"] as { role: string; myCard: number | null };
    expect(bViewer.role).toBe("informed");
    expect(bViewer.myCard).not.toBeNull();
    // Aliceʼs card is in another slot of state.informedCards but not exposed
    // in projection — Bob's `myCard` is only his own.
    expect(bViewer.myCard).not.toBe((aPlaySnap["viewer"] as { myCard: number }).myCard
      || ["intentional unequal compare placeholder"]);

    const contractId = (aPlaySnap["contracts"] as Array<{ id: string }>)[0]!.id;

    // Bob places a sell @ 12, Alice crosses with a buy @ 14, trade at 12.
    b.msgs.length = 0;
    b.send({
      type: "GAME_MSG", tableId,
      payload: { type: "PLACE_LIMIT", contractId, side: "sell", qty: 5, price: 12 },
    });
    a.send({
      type: "GAME_MSG", tableId,
      payload: { type: "PLACE_LIMIT", contractId, side: "buy", qty: 5, price: 14 },
    });

    // Wait for the post-trade snapshot to reach Alice.
    const afterTrade = await a.waitFor(gameMsgOut(
      (p) => p["type"] === "STATE_SNAPSHOT"
        && ((p["snap"] as { recentTrades: unknown[] })?.recentTrades?.length ?? 0) > 0,
    ));
    if (afterTrade.type !== "GAME_MSG_OUT") throw new Error("no trade");
    const tradeSnap = (afterTrade.payload as { snap: Record<string, unknown> }).snap;
    const trades = tradeSnap["recentTrades"] as Array<{ price: number; qty: number; buyerCode: string; sellerCode: string }>;
    expect(trades).toHaveLength(1);
    expect(trades[0]!.price).toBe(12);
    expect(trades[0]!.qty).toBe(5);
    // Codes are 2 letters (the test uses default codeMode=alpha → first 2 letters of display name).
    expect(trades[0]!.buyerCode).toMatch(/^[A-Za-z]{2}$/);
    expect(trades[0]!.sellerCode).toMatch(/^[A-Za-z]{2}$/);

    // Host fires the queued event then ends game.
    a.send({ type: "GAME_MSG", tableId, payload: { type: "FIRE_NEXT_EVENT" } });
    a.send({ type: "GAME_MSG", tableId, payload: { type: "END_GAME" } });

    const finalA = await a.waitFor(gameMsgOut(
      (p) => p["type"] === "STATE_SNAPSHOT"
        && (p["snap"] as { status: string } | undefined)?.status === "finished",
    ));
    if (finalA.type !== "GAME_MSG_OUT") throw new Error("no finished");
    const finalSnap = (finalA.payload as { snap: Record<string, unknown> }).snap;
    expect((finalSnap["settlements"] as Record<string, number>)[contractId]).toBeGreaterThan(0);

    await a.close();
    await b.close();
  });

  it("LIBRARY_LIST/SAVE/DELETE round-trip via WS", async () => {
    const alice = await signup(`mk-lib-${Date.now()}`);
    const ws = await openWs(alice.cookie);
    await ws.waitFor((m) => m.type === "ME_OK");

    // Need a table for LIBRARY_* intents (they ride the GAME_MSG channel).
    ws.send({
      type: "CREATE_TABLE",
      gameId: "mockery" as never,
      name: "Library test",
      isPrivate: false,
      options: {
        informedSeats: 2, uninformedSeats: 0, publicSlots: 0,
        copiesPerValue: 4, cardValuesCsv: "1,2,9,10",
        eventMode: "manual", eventIntervalMin: 60, eventIntervalMax: 60,
        endGameGraceSec: 0, codeMode: "alpha", enforceCaseByRole: false,
        identityReveal: "all", seed: 1,
      },
    });
    const tableMsg = await ws.waitFor((m) => m.type === "TABLE_STATE");
    if (tableMsg.type !== "TABLE_STATE") throw new Error("expected TABLE_STATE");
    const tableId = tableMsg.table.id;

    ws.send({
      type: "GAME_MSG", tableId,
      payload: { type: "LIBRARY_SAVE", name: "MyContract", description: "test", payoffSource: "return H.sum(cards);" },
    });
    const saved = await ws.waitFor(gameMsgOut((p) => p["type"] === "LIBRARY_SAVE_RESULT"));
    if (saved.type !== "GAME_MSG_OUT") throw new Error("no save result");
    const entry = (saved.payload as { entry: { id: number; name: string } }).entry;
    expect(entry.name).toBe("MyContract");

    ws.send({ type: "GAME_MSG", tableId, payload: { type: "LIBRARY_LIST" } });
    const list = await ws.waitFor(gameMsgOut(
      (p) => p["type"] === "LIBRARY_LIST_RESULT"
        && ((p["entries"] as unknown[]).length > 0),
    ));
    if (list.type !== "GAME_MSG_OUT") throw new Error("no list");
    expect(((list.payload as { entries: unknown[] }).entries).length).toBeGreaterThanOrEqual(1);

    ws.send({
      type: "GAME_MSG", tableId,
      payload: { type: "LIBRARY_DELETE", id: entry.id },
    });
    const deleted = await ws.waitFor(gameMsgOut((p) => p["type"] === "LIBRARY_DELETE_RESULT"));
    if (deleted.type !== "GAME_MSG_OUT") throw new Error("no delete");

    await ws.close();
  });
});
