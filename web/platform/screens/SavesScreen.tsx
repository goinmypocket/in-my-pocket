import { useEffect, useState } from "react";
import { asSaveId } from "../../../shared/ids";
import type {
  SaveSummary,
  ServerMessage,
} from "../../../shared/platformProtocol";
import { useClient } from "../PlatformClientContext";

interface Props {
  onBack(): void;
  onOpenTable(tableId: string): void;
}

export function SavesScreen({ onBack, onOpenTable }: Props) {
  const { send, subscribe, status } = useClient();
  const [saves, setSaves] = useState<SaveSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (status !== "open") return;
    send({ type: "LIST_SAVES" });
    const unsub = subscribe((msg: ServerMessage) => {
      if (msg.type === "SAVES_LIST") setSaves(msg.saves.slice());
      if (msg.type === "TABLE_STATE") onOpenTable(msg.table.id);
      if (msg.type === "ERROR") setError(msg.reason);
    });
    return unsub;
  }, [status, send, subscribe, onOpenTable]);

  function load(s: SaveSummary): void {
    const name = prompt("New table name?", s.name);
    if (!name) return;
    send({
      type: "LOAD_TABLE",
      saveId: asSaveId(s.id),
      name,
      isPrivate: false,
    });
  }

  function del(s: SaveSummary): void {
    if (!confirm(`Delete save "${s.name}"?`)) return;
    send({ type: "DELETE_SAVE", saveId: asSaveId(s.id) });
  }

  return (
    <div className="im-saves">
      <header className="im-saves__header">
        <h2>My saves</h2>
        <button onClick={onBack}>Back</button>
      </header>
      {error && <div className="im-error">{error}</div>}
      {saves === null ? (
        <p>Loading…</p>
      ) : saves.length === 0 ? (
        <p>You haven't saved any tables yet.</p>
      ) : (
        <ul className="im-saves__list">
          {saves.map((s) => {
            // The server stamps `summary.autoSavedFinish` on the
            // automatic snapshot taken when a game ends. Surface that
            // so the user can spot replay-ready saves at a glance.
            const isReplay = (s.summary as Record<string, unknown> | null)
              ?.autoSavedFinish === true
              || s.summary?.status === "finished";
            return (
              <li key={s.id}>
                <span>
                  <strong>{s.name}</strong>
                  {isReplay ? (
                    <span className="im-saves__tag">replay</span>
                  ) : null}
                  <span className="im-saves__meta">
                    {s.gameId} · saved {new Date(s.updatedAt).toLocaleString()}
                  </span>
                </span>
                <span>
                  <button onClick={() => load(s)}>
                    {isReplay ? "Replay" : "Load into new table"}
                  </button>
                  <button onClick={() => del(s)}>Delete</button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
