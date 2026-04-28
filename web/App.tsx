import { type ReactNode, useState } from "react";
import { AuthProvider, useAuth } from "./platform/AuthContext";
import {
  PlatformClientProvider,
  useClient,
} from "./platform/PlatformClientContext";
import {
  TableDrawerProvider,
  useTableDrawer,
} from "./platform/TableDrawerContext";
import { LoginScreen } from "./platform/screens/LoginScreen";
import { SavesScreen } from "./platform/screens/SavesScreen";
import { TableScreen } from "./platform/screens/TableScreen";
import { TablesScreen } from "./platform/screens/TablesScreen";
import "./styles.css";

type Route =
  | { kind: "tables" }
  | { kind: "table"; tableId: string }
  | { kind: "saves" };

export function App(): ReactNode {
  return (
    <AuthProvider>
      <Gate />
    </AuthProvider>
  );
}

function Gate(): ReactNode {
  const auth = useAuth();
  if (auth.status === "loading") return <div className="im-shell">Loading…</div>;
  if (auth.status === "anon") return <LoginScreen />;
  return (
    <PlatformClientProvider>
      <TableDrawerProvider>
        <Shell />
      </TableDrawerProvider>
    </PlatformClientProvider>
  );
}

function Shell(): ReactNode {
  const auth = useAuth();
  const { status } = useClient();
  const drawer = useTableDrawer();
  const [route, setRoute] = useState<Route>({ kind: "tables" });

  const onTable = route.kind === "table";
  const drawerHasContent = drawer.content !== null;

  return (
    <div className="im-shell">
      <header className="im-shell__nav">
        {onTable && drawerHasContent && (
          <button
            className="im-shell__hamburger"
            onClick={drawer.toggle}
            title="Table menu"
          >
            ☰
          </button>
        )}
        <span
          className="im-shell__brand"
          onClick={() => setRoute({ kind: "tables" })}
        >
          In My Pocket
        </span>
        <span className="im-shell__status">
          {status === "open" ? "connected" : status}
        </span>
        <span className="im-shell__user">
          {auth.user?.username}
          <button onClick={() => void auth.logout()}>Log out</button>
        </span>
      </header>

      <main className="im-shell__content">
        {route.kind === "tables" && (
          <TablesScreen
            onOpenTable={(tableId) => setRoute({ kind: "table", tableId })}
            onOpenSaves={() => setRoute({ kind: "saves" })}
          />
        )}
        {route.kind === "table" && (
          <TableScreen
            tableId={route.tableId}
            onLeave={() => setRoute({ kind: "tables" })}
          />
        )}
        {route.kind === "saves" && (
          <SavesScreen
            onBack={() => setRoute({ kind: "tables" })}
            onOpenTable={(tableId) => setRoute({ kind: "table", tableId })}
          />
        )}
      </main>

      {drawer.isOpen && drawerHasContent && (
        <>
          <div
            className="im-shell__drawer-backdrop"
            onClick={drawer.close}
          />
          <aside className="im-shell__drawer">
            <button
              className="im-shell__drawer-close"
              onClick={drawer.close}
              title="Close"
            >
              ✕
            </button>
            {drawer.content}
          </aside>
        </>
      )}
    </div>
  );
}
