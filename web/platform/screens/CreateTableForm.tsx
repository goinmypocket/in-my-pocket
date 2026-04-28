import { type FormEvent, useState } from "react";
import { asGameId } from "../../../shared/ids";
import { useClient } from "../PlatformClientContext";

// The registry is empty in v1 (no game wired). When games register, this
// form should read each definition's optionsSchema and render inputs by
// kind. For now, no game = nothing to create.
const AVAILABLE_GAMES: { id: string; displayName: string }[] = [];

export function CreateTableForm({ onCancel }: { onCancel(): void }) {
  const { send } = useClient();
  const [gameId, setGameId] = useState(AVAILABLE_GAMES[0]?.id ?? "");
  const [name, setName] = useState("");
  const [isPrivate, setIsPrivate] = useState(false);

  function onSubmit(e: FormEvent): void {
    e.preventDefault();
    if (!gameId) return;
    send({
      type: "CREATE_TABLE",
      gameId: asGameId(gameId),
      name: name.trim() || "Untitled table",
      isPrivate,
      options: {},
    });
  }

  if (AVAILABLE_GAMES.length === 0) {
    return (
      <div className="im-create-form im-create-form--empty">
        <p>
          No games installed yet. The platform's registry is empty — register a
          game module in <code>platform/games/registry.ts</code> to make it
          available here.
        </p>
        <button onClick={onCancel}>OK</button>
      </div>
    );
  }

  return (
    <form className="im-create-form" onSubmit={onSubmit}>
      <label>
        Game
        <select value={gameId} onChange={(e) => setGameId(e.target.value)}>
          {AVAILABLE_GAMES.map((g) => (
            <option key={g.id} value={g.id}>
              {g.displayName}
            </option>
          ))}
        </select>
      </label>
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="im-create-form__check">
        <input
          type="checkbox"
          checked={isPrivate}
          onChange={(e) => setIsPrivate(e.target.checked)}
        />
        Private (only people you share the table with see it)
      </label>
      <div>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit">Create</button>
      </div>
    </form>
  );
}
