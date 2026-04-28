// =============================================================================
// GameMount — lazy-loads a registered game's web entry and gives it a
// PlatformGameContext shaped to its expectations.
//
// The mapping from gameId → loader is statically declared here. Each
// game module exports a single React component as its default export
// from `<game-id>/web` (and optionally a CSS file at
// `<game-id>/web/styles.css`).
// =============================================================================
import {
  type ComponentType,
  lazy,
  type ReactNode,
  Suspense,
  useEffect,
  useMemo,
} from "react";
import { asTableId } from "../../shared/ids";
import type {
  ServerMessage,
  TableState,
} from "../../shared/platformProtocol";
import { useClient } from "./PlatformClientContext";

// Each loader returns a module whose default export is the game's
// React component. Vite's lazy-import plumbing handles code-splitting.
const GAME_LOADERS: Record<string, () => Promise<{ default: ComponentType<GameProps> }>> = {
  "coke-and-iron": async () => {
    const mod = await import("coke-and-iron/web");
    return { default: mod.default as unknown as ComponentType<GameProps> };
  },
  "mockery": async () => {
    const mod = await import("mockery/web");
    return { default: mod.default as unknown as ComponentType<GameProps> };
  },
};

export interface PlatformGameContext {
  readonly userId: string;
  readonly tableId: string;
  readonly hostUserId: string;
  send(payload: unknown): void;
  subscribe(cb: (payload: unknown) => void): () => void;
}

interface GameProps {
  readonly ctx: PlatformGameContext;
}

interface MountProps {
  readonly table: TableState;
  readonly userId: string;
}

export function GameMount({ table, userId }: MountProps): ReactNode {
  const { send, subscribe } = useClient();

  const ctx = useMemo<PlatformGameContext>(
    () => ({
      userId,
      tableId: table.id,
      hostUserId: table.hostUserId,
      send: (payload) => {
        send({
          type: "GAME_MSG",
          tableId: asTableId(table.id),
          payload,
        });
      },
      subscribe: (cb) =>
        subscribe((msg: ServerMessage) => {
          if (msg.type === "GAME_MSG_OUT" && msg.tableId === table.id) {
            cb(msg.payload);
          }
        }),
    }),
    [send, subscribe, userId, table.id, table.hostUserId],
  );

  const loader = GAME_LOADERS[table.gameId];
  if (!loader) {
    return (
      <div className="im-game-missing">
        <p>
          Game module <code>{table.gameId}</code> isn't bundled into this
          platform build. Add a loader entry in{" "}
          <code>web/platform/GameMount.tsx</code>.
        </p>
      </div>
    );
  }

  return <LoadedGame loader={loader} ctx={ctx} />;
}

interface LoadedGameProps {
  readonly loader: () => Promise<{ default: ComponentType<GameProps> }>;
  readonly ctx: PlatformGameContext;
}

function LoadedGame({ loader, ctx }: LoadedGameProps): ReactNode {
  const Component = useMemo(() => lazy(loader), [loader]);
  // `useEffect` here is just to nudge the Suspense boundary on prop
  // change; the real lifecycle is owned by the lazy component.
  useEffect(() => {
    /* no-op */
  }, [Component]);
  return (
    <Suspense fallback={<div>Loading game…</div>}>
      <Component ctx={ctx} />
    </Suspense>
  );
}
