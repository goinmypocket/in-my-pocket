import { type FormEvent, useEffect, useState } from "react";
import type { OptionField } from "../../../shared/GameDefinition";
import { asGameId } from "../../../shared/ids";
import type {
  GameInfo,
  ServerMessage,
} from "../../../shared/platformProtocol";
import { useClient } from "../PlatformClientContext";

export function CreateTableForm({ onCancel }: { onCancel(): void }) {
  const { send, subscribe, status } = useClient();
  const [games, setGames] = useState<GameInfo[] | null>(null);
  const [gameId, setGameId] = useState<string>("");
  const [name, setName] = useState("");
  const [isPrivate, setIsPrivate] = useState(false);
  const [options, setOptions] = useState<Record<string, unknown>>({});

  useEffect(() => {
    if (status !== "open") return;
    send({ type: "LIST_GAMES" });
    const unsub = subscribe((msg: ServerMessage) => {
      if (msg.type === "GAMES_LIST") {
        setGames(msg.games.slice());
        if (msg.games.length > 0 && !gameId) {
          setGameId(msg.games[0]!.id);
          setOptions(defaultOptions(msg.games[0]!));
        }
      }
    });
    return unsub;
  }, [status, send, subscribe, gameId]);

  const selectedGame = games?.find((g) => g.id === gameId);

  function selectGame(id: string): void {
    setGameId(id);
    const g = games?.find((x) => x.id === id);
    if (g) setOptions(defaultOptions(g));
  }

  function setOption(key: string, value: unknown): void {
    setOptions((prev) => ({ ...prev, [key]: value }));
  }

  function onSubmit(e: FormEvent): void {
    e.preventDefault();
    if (!gameId) return;
    send({
      type: "CREATE_TABLE",
      gameId: asGameId(gameId),
      name: name.trim() || "Untitled table",
      isPrivate,
      options,
    });
  }

  if (games === null) {
    return <div className="im-create-form">Loading games…</div>;
  }

  if (games.length === 0) {
    return (
      <div className="im-create-form im-create-form--empty">
        <p>
          No games installed yet. Register a game module in{" "}
          <code>platform/games/registry.ts</code> to make it available here.
        </p>
        <button onClick={onCancel}>OK</button>
      </div>
    );
  }

  return (
    <form className="im-create-form" onSubmit={onSubmit}>
      <label>
        Game
        <select value={gameId} onChange={(e) => selectGame(e.target.value)}>
          {games.map((g) => (
            <option key={g.id} value={g.id}>
              {g.displayName} ({g.minPlayers}–{g.maxPlayers} players)
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
      {selectedGame &&
        selectedGame.optionsSchema.map((field) => (
          <OptionInput
            key={field.key}
            field={field}
            value={options[field.key]}
            onChange={(v) => setOption(field.key, v)}
          />
        ))}
      <div>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit">Create</button>
      </div>
    </form>
  );
}

function OptionInput(props: {
  field: OptionField;
  value: unknown;
  onChange(v: unknown): void;
}) {
  const { field, value, onChange } = props;
  if (field.kind === "boolean") {
    return (
      <label className="im-create-form__check">
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
        />
        {field.label}
      </label>
    );
  }
  if (field.kind === "number") {
    return (
      <label>
        {field.label}
        <input
          type="number"
          value={typeof value === "number" ? value : ""}
          {...(field.min !== undefined ? { min: field.min } : {})}
          {...(field.max !== undefined ? { max: field.max } : {})}
          onChange={(e) => onChange(Number(e.target.value))}
        />
      </label>
    );
  }
  if (field.kind === "enum") {
    return (
      <label>
        {field.label}
        <select
          value={typeof value === "string" ? value : field.default}
          onChange={(e) => onChange(e.target.value)}
        >
          {field.choices.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </label>
    );
  }
  return (
    <label>
      {field.label}
      <input
        type="text"
        value={typeof value === "string" ? value : ""}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function defaultOptions(g: GameInfo): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of g.optionsSchema) out[f.key] = f.default;
  return out;
}
