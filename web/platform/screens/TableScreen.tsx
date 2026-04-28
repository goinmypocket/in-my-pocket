import { useEffect, useState } from "react";
import { asSaveId, asTableId } from "../../../shared/ids";
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
  const [saveDialog, setSaveDialog] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

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
  const isPlaying = state.status === "playing";

  const sidebar = (
    <SidebarContent
      state={state}
      tableId={tableId}
      isHost={isHost}
      myUserId={myUserId}
      mySeat={mySeat ?? null}
      send={send}
      onSaveClick={() => setSaveDialog(true)}
      onLeave={leave}
      error={error}
    />
  );

  return (
    <>
      {/* Lobby phase: classic two-column layout. */}
      {!isPlaying ? (
        <div className="im-table">
          <aside className="im-table__sidebar">{sidebar}</aside>
          <main className="im-table__content">
            <div className="im-table__lobby">
              <h2>Waiting to start</h2>
              <p>The host will start the game when seats are filled.</p>
            </div>
          </main>
        </div>
      ) : (
        // Playing phase: full-bleed game, sidebar lives behind a hamburger.
        <div className="im-table im-table--playing">
          <button
            className="im-table__drawer-toggle"
            onClick={() => setDrawerOpen((v) => !v)}
            title="Table controls"
          >
            ☰
          </button>
          <main className="im-table__game-fullbleed">
            {user && <GameMount table={state} userId={user.id} />}
          </main>
          {drawerOpen && (
            <>
              <div
                className="im-table__drawer-backdrop"
                onClick={() => setDrawerOpen(false)}
              />
              <aside className="im-table__drawer">
                <button
                  className="im-table__drawer-close"
                  onClick={() => setDrawerOpen(false)}
                  title="Close"
                >
                  ✕
                </button>
                {sidebar}
              </aside>
            </>
          )}
        </div>
      )}

      {saveDialog && (
        <SaveDialog
          state={state}
          onClose={() => setSaveDialog(false)}
          onSave={(name, overwriteSaveId) => {
            send({
              type: "SAVE_TABLE",
              tableId: asTableId(tableId),
              name,
              ...(overwriteSaveId !== undefined ? { overwriteSaveId } : {}),
            });
            setSaveDialog(false);
          }}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Sidebar content — same content shown in lobby's column or the hamburger
// drawer during play.
// ---------------------------------------------------------------------------

type ClientSend = ReturnType<typeof useClient>["send"];

interface SidebarProps {
  state: TableState;
  tableId: string;
  isHost: boolean;
  myUserId: string | null;
  mySeat: TableState["slots"][number] | null;
  send: ClientSend;
  onSaveClick(): void;
  onLeave(): void;
  error: string | null;
}

function SidebarContent({
  state,
  tableId,
  isHost,
  myUserId,
  mySeat,
  send,
  onSaveClick,
  onLeave,
  error,
}: SidebarProps) {
  return (
    <>
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
                {!itsMe &&
                  occupied &&
                  isHost &&
                  state.status === "lobby" && (
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
        <button onClick={onSaveClick}>
          {state.currentSaveName
            ? `Save ("${state.currentSaveName}")`
            : "Save…"}
        </button>
      )}

      {!mySeat && state.status === "lobby" && (
        <p className="im-table__hint">
          You're spectating. Click Claim on an open seat to play.
        </p>
      )}

      <button onClick={onLeave}>Leave table</button>

      {isHost && (
        <button
          className="im-table__delete"
          onClick={() => {
            if (!confirm(`Delete table "${state.name}"? This kicks everyone.`))
              return;
            send({ type: "DELETE_TABLE", tableId: asTableId(tableId) });
            onLeave();
          }}
        >
          Delete table
        </button>
      )}

      {error && <div className="im-error">{error}</div>}
    </>
  );
}

// ---------------------------------------------------------------------------
// Save dialog — offers overwrite vs new when the table already has a save.
// ---------------------------------------------------------------------------

interface SaveDialogProps {
  state: TableState;
  onClose(): void;
  onSave(name: string, overwriteSaveId?: ReturnType<typeof asSaveId>): void;
}

function SaveDialog({ state, onClose, onSave }: SaveDialogProps) {
  const [name, setName] = useState(state.currentSaveName ?? state.name);
  const hasExisting = state.currentSaveId !== null;

  return (
    <div className="im-modal-backdrop" onClick={onClose}>
      <div className="im-modal" onClick={(e) => e.stopPropagation()}>
        <h3>Save game</h3>

        {hasExisting ? (
          <>
            <p className="im-modal__hint">
              This table was last saved as <strong>"{state.currentSaveName}"</strong>.
              Overwrite it, or save under a new name?
            </p>
            <div className="im-modal__row">
              <button
                onClick={() =>
                  onSave(state.currentSaveName ?? state.name, asSaveId(state.currentSaveId!))
                }
              >
                Overwrite "{state.currentSaveName}"
              </button>
            </div>
            <hr />
            <p className="im-modal__hint">…or save as a new save:</p>
          </>
        ) : (
          <p className="im-modal__hint">Pick a name for this save.</p>
        )}

        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Save name"
        />

        <div className="im-modal__row">
          <button onClick={onClose}>Cancel</button>
          <button
            onClick={() => {
              const trimmed = name.trim();
              if (!trimmed) return;
              onSave(trimmed);
            }}
          >
            {hasExisting ? "Save as new" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
