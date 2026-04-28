import { useEffect, useState } from "react";
import type {
  ServerMessage,
  TableSummary,
} from "../../../shared/platformProtocol";
import { useClient } from "../PlatformClientContext";
import { CreateTableForm } from "./CreateTableForm";

interface Props {
  onOpenTable(tableId: string): void;
  onOpenSaves(): void;
}

export function TablesScreen({ onOpenTable, onOpenSaves }: Props) {
  const { send, subscribe, status } = useClient();
  const [tables, setTables] = useState<TableSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  useEffect(() => {
    if (status !== "open") return;
    send({ type: "LIST_TABLES" });
    const unsub = subscribe((msg: ServerMessage) => {
      if (msg.type === "TABLES_LIST") setTables(msg.tables.slice());
      if (msg.type === "TABLE_STATE") {
        // Newly created or loaded table — navigate into it.
        onOpenTable(msg.table.id);
      }
      if (msg.type === "ERROR") setError(msg.reason);
    });
    return unsub;
  }, [status, send, subscribe, onOpenTable]);

  return (
    <div className="im-tables">
      <header className="im-tables__header">
        <h2>Tables</h2>
        <div>
          <button onClick={() => send({ type: "LIST_TABLES" })}>Refresh</button>
          <button onClick={onOpenSaves}>My saves</button>
          <button onClick={() => setShowCreate((v) => !v)}>
            {showCreate ? "Cancel" : "+ Create table"}
          </button>
        </div>
      </header>

      {showCreate && <CreateTableForm onCancel={() => setShowCreate(false)} />}

      {error && <div className="im-error">{error}</div>}

      {tables === null ? (
        <p>Loading…</p>
      ) : tables.length === 0 ? (
        <p>No active tables. Create one to start.</p>
      ) : (
        <ul className="im-tables__list">
          {tables.map((t) => (
            <li key={t.id}>
              <button onClick={() => onOpenTable(t.id)}>
                <span className="im-tables__name">{t.name}</span>
                <span className="im-tables__meta">
                  {t.gameId} · {t.status} · {t.playerCount}/{t.maxPlayers} players
                  {t.spectatorCount > 0 ? ` · ${t.spectatorCount} watching` : ""}
                  {t.isPrivate ? " · private" : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
