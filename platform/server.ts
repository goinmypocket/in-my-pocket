// =============================================================================
// In My Pocket — platform server entry point.
//
// Skeleton. The shape is here; the bodies are stubs. Filling these
// out is Phase 2 of the rollout in docs/multi-game-platform.md:
//   - Auth (signup with invite, login, JWT cookies)
//   - Tables CRUD (create, list, join, leave, kick, start)
//   - Save / load
//   - WebSocket router that wraps GAME_MSG envelopes and routes by tableId
//
// Until that's filled in, this file documents the seams and exits.
// =============================================================================
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer } from "ws";
import { buildRegistry } from "./games/registry";

interface ServerOpts {
  readonly port: number;
  readonly dataDir: string;
}

export async function startPlatform(opts: ServerOpts): Promise<void> {
  const registry = await buildRegistry();
  console.log(
    `[in-my-pocket] registry loaded with ${registry.size} game(s):`,
    [...registry.keys()].join(", ") || "(none yet)",
  );

  const http = createServer(handleHttp);
  const wss = new WebSocketServer({ noServer: true });

  http.on("upgrade", (req, socket, head) => {
    if (req.url === "/ws") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on("connection", (_ws, _req) => {
    // TODO: wire up the platform protocol (HELLO, auth, tables, GAME_MSG).
    // See shared/platformProtocol.ts for the message shape.
  });

  http.listen(opts.port, () => {
    console.log(`[in-my-pocket] listening on http://localhost:${opts.port}`);
    console.log(`[in-my-pocket] data dir: ${opts.dataDir}`);
  });
}

function handleHttp(_req: IncomingMessage, res: ServerResponse): void {
  // TODO: serve web/dist/ and the auth/tables HTTP endpoints.
  res.statusCode = 501;
  res.end("not implemented");
}

// CLI entry — `npm run server`. Defaults are dev-friendly; production
// deployments should pass real values via env or args.
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  void startPlatform({
    port: Number(process.env["PORT"] ?? 8787),
    dataDir: process.env["DATA_DIR"] ?? "./data",
  });
}
