import { useEffect, useMemo, useState } from "react";
import { asSaveId, asTableId } from "../../../shared/ids";
import type {
  ServerMessage,
  TableState,
} from "../../../shared/platformProtocol";
import { useAuth } from "../AuthContext";
import { useClient } from "../PlatformClientContext";
import { GameMount } from "../GameMount";
import { useProvideDrawerContent, useTableDrawer } from "../TableDrawerContext";

interface Props {
  tableId: string;
  onLeave(): void;
}

export function TableScreen({ tableId, onLeave }: Props) {
  const { send, subscribe, status } = useClient();
  const { user } = useAuth();
  const drawer = useTableDrawer();
  const [state, setState] = useState<TableState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [closed, setClosed] = useState<string | null>(null);
  const [saveDialog, setSaveDialog] = useState(false);

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

  // "Back to tables" — navigate away but DON'T release the seat.
  // The user's slot stays held; reconnecting takes them back to it.
  const backToTables = onLeave;

  // "Give up your seat" — explicit release. Slot becomes claimable
  // by anyone (or remains empty in a started game until reclaimed).
  function giveUpSeat(): void {
    send({ type: "LEAVE_TABLE", tableId: asTableId(tableId) });
  }

  const isHost = user !== null && state !== null && state.hostUserId === user.id;
  const myUserId = user?.id ?? null;
  const mySeat = state?.slots.find((s) => s.claimedBy?.id === myUserId) ?? null;
  const isPlaying = state?.status === "playing";

  // Provide drawer content for the platform top-nav hamburger.
  const drawerContent = useMemo(() => {
    if (!state) return null;
    return (
      <SidebarContent
        state={state}
        tableId={tableId}
        isHost={isHost}
        myUserId={myUserId}
        mySeat={mySeat}
        send={send}
        onSaveClick={() => {
          setSaveDialog(true);
          drawer.close();
        }}
        onBack={() => {
          drawer.close();
          backToTables();
        }}
        onGiveUpSeat={() => {
          if (
            !confirm(
              "Give up your seat? Another player will be able to claim it.",
            )
          )
            return;
          giveUpSeat();
          drawer.close();
        }}
        error={error}
      />
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, tableId, isHost, myUserId, mySeat, error]);

  useProvideDrawerContent(drawerContent);

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

  return (
    <>
      {!isPlaying ? (
        // Lobby: the sidebar shows in the page (drawer is also wired
        // via useProvideDrawerContent so the top-nav hamburger has it
        // too — handy on small screens).
        <div className="im-table">
          <aside className="im-table__sidebar">{drawerContent}</aside>
          <main className="im-table__content">
            <div className="im-table__lobby">
              <h2>Waiting to start</h2>
              <p>The host will start the game when seats are filled.</p>
            </div>
          </main>
        </div>
      ) : (
        // Playing: full-bleed game canvas; chrome is in the platform
        // top nav's hamburger drawer.
        <div className="im-table im-table--playing">
          <main className="im-table__game-fullbleed">
            {user && <GameMount table={state} userId={user.id} />}
          </main>
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
// Sidebar content
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
  onBack(): void;
  onGiveUpSeat(): void;
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
  onBack,
  onGiveUpSeat,
  error,
}: SidebarProps) {
  const isPlaying = state.status === "playing";
  // Fallback: if the server didn't provide playableSeatIndices (stale
  // build, older table), treat every seat as playable in the lobby
  // and only the occupied ones during play. Without this, no Claim
  // button renders and the seat looks broken.
  const playableSet = useMemo(() => {
    if (state.playableSeatIndices && state.playableSeatIndices.length > 0) {
      return new Set(state.playableSeatIndices);
    }
    if (state.status === "lobby") {
      return new Set(state.slots.map((s) => s.seatIndex));
    }
    return new Set(
      state.slots.filter((s) => s.claimedBy !== null).map((s) => s.seatIndex),
    );
  }, [state.playableSeatIndices, state.status, state.slots]);

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
          const isPlayable = playableSet.has(slot.seatIndex);
          const greyedOut = !isPlayable && !occupied;
          return (
            <li
              key={slot.seatIndex}
              className={greyedOut ? "is-disabled" : undefined}
              title={
                greyedOut
                  ? "This seat wasn't in the game when it started — it can't be claimed mid-game."
                  : undefined
              }
            >
              <span className="im-table__seat">
                Seat {slot.seatIndex + 1}:{" "}
                {occupied ? (
                  slot.claimedBy!.username
                ) : greyedOut ? (
                  <em>not in this game</em>
                ) : (
                  <em>open</em>
                )}
              </span>
              <span className="im-table__seat-actions">
                {!occupied && isPlayable && (
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
                {!itsMe && occupied && isHost && (
                  <button
                    onClick={() => {
                      const name = slot.claimedBy?.username ?? "this player";
                      const prompt =
                        state.status === "playing"
                          ? `Kick ${name} mid-game? Their seat will be empty until someone reclaims it; the game keeps running.`
                          : `Kick ${name} from this table?`;
                      if (!confirm(prompt)) return;
                      send({
                        type: "KICK_USER",
                        tableId: asTableId(tableId),
                        seatIndex: slot.seatIndex,
                      });
                    }}
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

      {isHost && isPlaying && (
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

      <button onClick={onBack}>Back to tables</button>
      <p className="im-table__hint">
        Closes the tab? Your seat stays held — reconnect any time and you'll
        land back in it.
      </p>

      {mySeat && isPlaying && (
        <button className="im-table__giveup" onClick={onGiveUpSeat}>
          Give up your seat
        </button>
      )}

      {isHost && (
        <button
          className="im-table__delete"
          onClick={() => {
            if (!confirm(`Delete table "${state.name}"? This kicks everyone.`))
              return;
            send({ type: "DELETE_TABLE", tableId: asTableId(tableId) });
            onBack();
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
// Save dialog — overwrite vs new
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
              This table was last saved as{" "}
              <strong>"{state.currentSaveName}"</strong>. Overwrite it, or save
              under a new name?
            </p>
            <div className="im-modal__row">
              <button
                onClick={() =>
                  onSave(
                    state.currentSaveName ?? state.name,
                    asSaveId(state.currentSaveId!),
                  )
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
