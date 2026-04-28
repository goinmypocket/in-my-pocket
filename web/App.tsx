// =============================================================================
// Browser shell — the chrome that wraps every game UI on the platform.
// Skeleton: routes between login / tables / table-view / saves screens
// and lazy-mounts the active game's <App> inside a content area.
//
// See docs/multi-game-platform.md §6.6 for the shell-vs-game split.
// =============================================================================
import { type ReactNode, useState } from "react";

type View =
  | { kind: "login" }
  | { kind: "tables" }
  | { kind: "table"; tableId: string }
  | { kind: "saves" };

export function App(): ReactNode {
  const [view] = useState<View>({ kind: "login" });

  // TODO: real platform shell. Today this renders a placeholder so the
  // build pipeline has something to point at.
  return (
    <div className="im-shell">
      <header className="im-shell__nav">In My Pocket</header>
      <main className="im-shell__content">
        {view.kind === "login" && <p>login screen — not implemented</p>}
        {view.kind === "tables" && <p>tables list — not implemented</p>}
        {view.kind === "saves" && <p>saves library — not implemented</p>}
        {view.kind === "table" && <p>table view — not implemented</p>}
      </main>
    </div>
  );
}
