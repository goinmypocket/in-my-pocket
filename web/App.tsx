import { type ReactNode, useState } from "react";
import { AuthProvider, useAuth } from "./platform/AuthContext";
import {
  PlatformClientProvider,
  useClient,
} from "./platform/PlatformClientContext";
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
      <Shell />
    </PlatformClientProvider>
  );
}

function Shell(): ReactNode {
  const auth = useAuth();
  const { status } = useClient();
  const [route, setRoute] = useState<Route>({ kind: "tables" });

  return (
    <div className="im-shell">
      <header className="im-shell__nav">
        <span className="im-shell__brand" onClick={() => setRoute({ kind: "tables" })}>
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
    </div>
  );
}
