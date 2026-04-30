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
import { AdminScreen } from "./platform/screens/AdminScreen";
import { LoginScreen } from "./platform/screens/LoginScreen";
import { SavesScreen } from "./platform/screens/SavesScreen";
import { TableScreen } from "./platform/screens/TableScreen";
import { TablesScreen } from "./platform/screens/TablesScreen";
import "./styles.css";

type Route =
  | { kind: "tables" }
  | { kind: "table"; tableId: string }
  | { kind: "saves" }
  | { kind: "admin" };

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
          {auth.user?.isAdmin && (
            <button
              onClick={() => setRoute({ kind: "admin" })}
              title="Admin console — invites + users"
            >
              Admin
            </button>
          )}
          <button onClick={() => void auth.logout()}>Log out</button>
          <DeleteAccountButton />
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
        {route.kind === "admin" && auth.user?.isAdmin && (
          <AdminScreen onBack={() => setRoute({ kind: "tables" })} />
        )}
      </main>

      {/* End-user "delete my account" affordance lives next to Log out
       * in the top nav. Wraps a small confirm-dialog component so the
       * Shell stays declarative. */}
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

function DeleteAccountButton(): ReactNode {
  const auth = useAuth();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!auth.user) return null;
  return (
    <>
      <button
        className="im-shell__danger"
        onClick={() => setOpen(true)}
        title="Permanently delete this account and all data you own"
      >
        Delete account
      </button>
      {open && (
        <div className="im-modal-backdrop" onClick={() => setOpen(false)}>
          <div className="im-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Delete account</h3>
            <p className="im-modal__hint">
              This permanently deletes your account, every save you own, and
              every table you host. Tables you've joined as a guest stay,
              your seat just becomes empty. This cannot be undone.
            </p>
            <p className="im-modal__hint">
              Confirm with your current password.
            </p>
            <input
              type="password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Current password"
            />
            {error && <div className="im-error">{error}</div>}
            <div className="im-modal__row">
              <button onClick={() => setOpen(false)}>Cancel</button>
              <button
                disabled={busy || password.length === 0}
                onClick={async () => {
                  setBusy(true);
                  setError(null);
                  try {
                    await auth.deleteAccount({ password });
                  } catch (e) {
                    setError(e instanceof Error ? e.message : "failed");
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? "Deleting…" : "Delete forever"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
