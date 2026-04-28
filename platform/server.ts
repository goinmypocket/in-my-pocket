// =============================================================================
// In My Pocket — platform server entry point.
// =============================================================================
import { existsSync, readFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type { GameDefinition } from "../shared/GameDefinition";
import type { GameId, UserId } from "../shared/ids";
import { PLATFORM_PROTOCOL_VERSION } from "../shared/platformProtocol";
import { handleAuthHttp, readUserIdFromCookie } from "./auth/routes";
import { loadOrCreateSecret, makeSigner } from "./auth/jwt";
import { makeRateLimiter } from "./auth/rateLimit";
import { openDb } from "./db/client";
import * as usersDb from "./db/users";
import { buildRegistry } from "./games/registry";
import { TableManager } from "./tables/TableManager";
import { ConnectionRegistry } from "./ws/connections";
import { dispatchMessage, parseClientMessage } from "./ws/dispatch";

interface ServerOpts {
  readonly port: number;
  readonly dataDir: string;
  /** Optional: directory of built static assets. */
  readonly staticDir?: string;
  /** Optional: override the registered games. Used by tests to inject
   *  a stub GameDefinition without depending on what's compiled in. */
  readonly registryOverride?: ReadonlyMap<GameId, GameDefinition>;
}

export interface RunningPlatform {
  readonly port: number;
  close(): Promise<void>;
}

export async function startPlatform(opts: ServerOpts): Promise<RunningPlatform> {
  const db = openDb(opts.dataDir);
  const secret = loadOrCreateSecret(opts.dataDir);
  const signer = makeSigner(secret);
  const limiter = makeRateLimiter({ capacity: 10, refillPerSec: 0.2 });

  const registryEntries = opts.registryOverride ?? (await buildRegistry());
  const registry = {
    get: (id: GameId) => registryEntries.get(id),
    has: (id: GameId) => registryEntries.has(id),
    list: () => Array.from(registryEntries.values()),
  };
  console.log(
    `[in-my-pocket] registry loaded with ${registryEntries.size} game(s):`,
    Array.from(registryEntries.keys()).join(", ") || "(none yet)",
  );

  const connections = new ConnectionRegistry();
  const tableManager = new TableManager(db, registry, connections);

  const http = createServer((req, res) => {
    void handleHttp(req, res, {
      db,
      signer,
      limiter,
      ...(opts.staticDir !== undefined ? { staticDir: opts.staticDir } : {}),
    });
  });

  const wss = new WebSocketServer({ noServer: true });

  http.on("upgrade", (req, socket, head) => {
    if (req.url !== "/ws") {
      socket.destroy();
      return;
    }
    void (async () => {
      const userId = await readUserIdFromCookie(req, signer);
      if (!userId) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      const user = usersDb.findUserById(db, userId);
      if (!user) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req, userId);
      });
    })();
  });

  wss.on("connection", (ws: WebSocket, _req: IncomingMessage, userId: UserId) => {
    const isFirstSocket = connections.countSockets(userId) === 0;
    connections.add(userId, ws);

    const user = usersDb.findUserById(db, userId);
    if (!user) {
      ws.close(1011, "user gone");
      return;
    }

    ws.send(
      JSON.stringify({
        type: "HELLO",
        protocolVersion: PLATFORM_PROTOCOL_VERSION,
      }),
    );
    ws.send(
      JSON.stringify({
        type: "ME_OK",
        user: { id: user.id, username: user.username },
      }),
    );

    if (isFirstSocket) tableManager.onUserConnected(userId);

    ws.on("message", (data) => {
      const text = typeof data === "string" ? data : data.toString();
      const msg = parseClientMessage(text);
      if (!msg) {
        ws.send(JSON.stringify({ type: "ERROR", reason: "bad message" }));
        return;
      }
      try {
        dispatchMessage(ws, userId, msg, tableManager);
      } catch (err) {
        console.error("[in-my-pocket] dispatch error", err);
        ws.send(
          JSON.stringify({
            type: "ERROR",
            reason: "internal error",
            cause: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    });

    ws.on("close", () => {
      connections.remove(userId, ws);
      if (connections.countSockets(userId) === 0) {
        tableManager.onUserDisconnected(userId);
      }
    });

    ws.on("error", () => {
      // Suppress; close handler does the cleanup.
    });
  });

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(opts.port, () => {
      http.removeListener("error", reject);
      resolve();
    });
  });

  const address = http.address();
  const port = typeof address === "object" && address !== null ? address.port : opts.port;
  console.log(`[in-my-pocket] listening on http://localhost:${port}`);
  console.log(`[in-my-pocket] data dir: ${opts.dataDir}`);

  return {
    port,
    close() {
      return new Promise<void>((resolve) => {
        wss.close(() => {
          http.close(() => {
            db.close();
            resolve();
          });
        });
      });
    },
  };
}

interface HttpCtx {
  readonly db: ReturnType<typeof openDb>;
  readonly signer: ReturnType<typeof makeSigner>;
  readonly limiter: ReturnType<typeof makeRateLimiter>;
  readonly staticDir?: string;
}

async function handleHttp(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HttpCtx,
): Promise<void> {
  try {
    if (await handleAuthHttp(req, res, ctx)) return;

    if (ctx.staticDir && (req.method === "GET" || req.method === "HEAD")) {
      if (serveStatic(req, res, ctx.staticDir)) return;
    }

    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "not found" }));
  } catch (err) {
    console.error("[in-my-pocket] http error", req.method, req.url, err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          error: "internal error",
          cause: err instanceof Error ? err.message : String(err),
        }),
      );
    } else if (!res.writableEnded) {
      res.end();
    }
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  staticDir: string,
): boolean {
  const url = new URL(req.url ?? "/", "http://localhost");
  let path = decodeURIComponent(url.pathname);
  if (path === "/" || path.endsWith("/")) path = "/index.html";

  const root = resolve(staticDir);
  const candidate = normalize(join(root, path));
  if (!candidate.startsWith(root + sep) && candidate !== root) return false;

  let target: string;
  if (existsSync(candidate)) {
    target = candidate;
  } else {
    const fallback = join(root, "index.html");
    if (!existsSync(fallback)) return false;
    target = fallback;
  }

  const buf = readFileSync(target);
  const mime = MIME[extname(target).toLowerCase()] ?? "application/octet-stream";
  res.statusCode = 200;
  res.setHeader("Content-Type", mime);
  res.setHeader("Content-Length", String(buf.length));
  res.end(buf);
  return true;
}

// "is this file the entrypoint?" on Windows + Node + tsx is fiddly:
// import.meta.url uses file:/// (three slashes) and process.argv[1] is a
// raw OS path. Normalise both through fileURLToPath / resolve before
// comparing.
import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "node:path";
const argvEntry = process.argv[1];
const isMain =
  argvEntry !== undefined &&
  resolvePath(fileURLToPath(import.meta.url)).toLowerCase() ===
    resolvePath(argvEntry).toLowerCase();
if (isMain) {
  const port = Number(process.env["PORT"] ?? 8787);
  const dataDir = process.env["DATA_DIR"] ?? "./data";
  const staticDir = process.env["STATIC_DIR"];
  void startPlatform({
    port,
    dataDir,
    ...(staticDir !== undefined ? { staticDir } : {}),
  });
}
