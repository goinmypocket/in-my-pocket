import { useEffect, useState } from "react";
import { asTableId } from "../../../shared/ids";
import type {
  ServerMessage,
  TableState,
} from "../../../shared/platformProtocol";
import { useAuth } from "../AuthContext";
import { useClient } from "../PlatformClientContext";
import { GameMount } from "../GameMount";

interface Props {
  tableId: string;
  onLeave(): void;
}

export function TableScreen({ tableId, onLeave }: Props) {
  const { send, subscribe, status } = useClient();
  const { user } = useAuth();
  const [state, setState] = useState<TableState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [closed, setClosed] = useState<string | null>(null);

  useEffect(() => {
    if (status !== "open") return;
    setError(null);
    setClosed(null);
    const unsub = subscribe((msg: ServerMessage) => {
      if (msg.type === "TABLE_STATE" && msg.table.id === tableId) {
        setState(msg.table);
      }
      if (msg.type === "ERROR") setError(msg.reason);
      if (msg.type === "TABLE_CLOSED" && msg.tableId === tableId) {
        setClosed(msg.reason);
      }
    });
    // Joining as spectator gets us a TABLE_STATE; if we already hold a seat,
    // the platform re-attaches us on connect (TABLE_STATE arrives via
    // broadcast). Either way, ask for the current state.
    send({
      type: "JOIN_TABLE",
      tableId: asTableId(tableId),
      seatIndex: -1,
      kind: "spectator",
    });
    return unsub;
  }, [status, send, subscribe, tableId]);

  function leave(): void {
    send({ type: "LEAVE_TABLE", tableId: asTableId(tableId) });
    onLeave();
  }

  if (closed) {
    return (
      <div className="im-table">
        <p>This table closed: {closed}</p>
        <button onClick={onLeave}>Back to tables</button>
      </div>
    );
  }

  if (!state) {
    return (
      <div className="im-table">
        <p>Loading table…</p>
        {error && <div className="im-error">{error}</div>}
        <button onClick={onLeave}>Back to tables</button>
      </div>
    );
  }

  const isHost = user !== null && state.hostUserId === user.id;
  const myUserId = user?.id ?? null;
  const mySeat = state.slots.find((s) => s.claimedBy?.id === myUserId);

  return (
    <div className="im-table">
      <aside className="im-table__sidebar">
        <h3>{state.name}</h3>
        <p className="im-table__meta">
          {state.gameId} · {state.status}
          {isHost ? " · you host" : ""}
        </p>

        <ul className="im-table__slots">
          {state.slots.map((slot) => {
            const occupied = slot.claimedBy !== null;
            const itsMe = slot.claimedBy?.id === myUserId;
            return (
              <li key={slot.seatIndex}>
                <span className="im-table__seat">
                  Seat {slot.seatIndex + 1}:{" "}
                  {occupied ? slot.claimedBy!.username : <em>open</em>}
                </span>
                <span className="im-table__seat-actions">
                  {!occupied && state.status === "lobby" && (
                    <button
                      onClick={() =>
                        send({
                          type: "JOIN_TABLE",
                          tableId: asTableId(tableId),
                          seatIndex: slot.seatIndex,
                          kind: "player",
                        })
                      }
                    >
                      Claim
                    </button>
                  )}
                  {itsMe && state.status === "lobby" && (
                    <button
                      onClick={() =>
                        send({
                          type: "LEAVE_TABLE",
                          tableId: asTableId(tableId),
                        })
                      }
                    >
                      Release
                    </button>
                  )}
                  {!itsMe && occupied && isHost && state.status === "lobby" && (
                    <button
                      onClick={() =>
                        send({
                          type: "KICK_USER",
                          tableId: asTableId(tableId),
                          seatIndex: slot.seatIndex,
                        })
                      }
                    >
                      Kick
                    </button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>

        {isHost && state.status === "lobby" && (
          <button
            className="im-table__start"
            onClick={() =>
              send({ type: "START_GAME", tableId: asTableId(tableId) })
            }
          >
            Start game
          </button>
        )}

        {isHost && state.status === "playing" && (
          <button
            onClick={() => {
              const name = prompt("Save name?");
              if (!name) return;
              send({
                type: "SAVE_TABLE",
                tableId: asTableId(tableId),
                name,
              });
            }}
          >
            Save
          </button>
        )}

        {!mySeat && state.status === "lobby" && (
          <p className="im-table__hint">You're spectating. Click Claim on an open seat to play.</p>
        )}

        <button onClick={leave}>Leave table</button>

        {error && <div className="im-error">{error}</div>}
      </aside>

      <main className="im-table__content">
        {state.status === "lobby" ? (
          <div className="im-table__lobby">
            <h2>Waiting to start</h2>
            <p>The host will start the game when seats are filled.</p>
          </div>
        ) : (
          user && <GameMount table={state} userId={user.id} />
        )}
      </main>
    </div>
  );
}
