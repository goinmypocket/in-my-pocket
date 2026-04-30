// =============================================================================
// AdminScreen — admin-only console for managing invite codes and users.
// Mounted from App.tsx when the signed-in user has isAdmin=true; the
// server enforces the same gate, so a non-admin landing here would just
// see 403s on every fetch.
//
// Two tabs:
//
//   * Invites — mint new codes (uses / expires / role / note), list
//     existing codes, revoke active ones.
//   * Users — paginated user table, filter by username substring and/or
//     admin role, promote / demote individuals.
// =============================================================================
import { type ReactNode, useCallback, useEffect, useState } from "react";
import {
  adminListInvites,
  adminListUsers,
  adminMintInvite,
  adminRevokeInvite,
  adminSetUserRole,
  type AdminInviteRow,
  type AdminUserRow,
} from "../api";
import { useAuth } from "../AuthContext";

type Tab = "invites" | "users";

interface Props {
  onBack(): void;
}

export function AdminScreen({ onBack }: Props): ReactNode {
  const [tab, setTab] = useState<Tab>("invites");
  return (
    <div className="im-admin">
      <div className="im-admin__nav">
        <button onClick={onBack}>← Back</button>
        <button
          className={tab === "invites" ? "is-active" : ""}
          onClick={() => setTab("invites")}
        >
          Invites
        </button>
        <button
          className={tab === "users" ? "is-active" : ""}
          onClick={() => setTab("users")}
        >
          Users
        </button>
      </div>
      {tab === "invites" ? <InvitesTab /> : <UsersTab />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Invites tab
// ---------------------------------------------------------------------------

function InvitesTab(): ReactNode {
  const [invites, setInvites] = useState<AdminInviteRow[] | null>(null);
  const [activeOnly, setActiveOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Mint form state
  const [uses, setUses] = useState(1);
  const [expiresAt, setExpiresAt] = useState("");
  const [grantsAdmin, setGrantsAdmin] = useState(false);
  const [note, setNote] = useState("");
  const [lastMinted, setLastMinted] = useState<AdminInviteRow | null>(null);

  const reload = useCallback(async () => {
    try {
      setError(null);
      const r = await adminListInvites({ activeOnly });
      setInvites(r.invites);
    } catch (e) {
      setError(e instanceof Error ? e.message : "load failed");
    }
  }, [activeOnly]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function onMint(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const r = await adminMintInvite({
        uses: Math.max(1, Math.floor(uses) || 1),
        expiresAt: expiresAt.trim().length === 0 ? null : expiresAt,
        grantsAdmin,
        note: note.trim().length === 0 ? null : note,
      });
      setLastMinted(r.invite);
      // Reset to safe defaults so the next mint is intentional.
      setNote("");
      void reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "mint failed");
    } finally {
      setBusy(false);
    }
  }

  async function onRevoke(code: string): Promise<void> {
    if (!confirm("Revoke this invite code? Existing accounts keep working.")) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await adminRevokeInvite({ code });
      void reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "revoke failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="im-admin__section">
      <h2>Mint invite</h2>
      <div className="im-admin__form">
        <label>
          Uses
          <input
            type="number"
            min={1}
            value={uses}
            onChange={(e) => setUses(Number(e.target.value))}
          />
        </label>
        <label>
          Expires (YYYY-MM-DD, blank = never)
          <input
            type="date"
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
          />
        </label>
        <label className="im-admin__check">
          <input
            type="checkbox"
            checked={grantsAdmin}
            onChange={(e) => setGrantsAdmin(e.target.checked)}
          />
          Admin invite (redeemers become admins)
        </label>
        <label>
          Note
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="optional, for your own bookkeeping"
          />
        </label>
        <button disabled={busy} onClick={() => void onMint()}>
          {busy ? "…" : "Mint code"}
        </button>
      </div>
      {lastMinted && (
        <div className="im-admin__minted">
          <strong>{lastMinted.formatted}</strong>{" "}
          ({lastMinted.maxUses} use{lastMinted.maxUses === 1 ? "" : "s"},{" "}
          {lastMinted.grantsAdmin ? "admin" : "user"} tier
          {lastMinted.expiresAt ? `, expires ${lastMinted.expiresAt.slice(0, 10)}` : ""})
          <br />
          <small>Share this code with the new account holder.</small>
        </div>
      )}

      <h2>Existing codes</h2>
      <label className="im-admin__check">
        <input
          type="checkbox"
          checked={activeOnly}
          onChange={(e) => setActiveOnly(e.target.checked)}
        />
        Active only (hide exhausted / expired / revoked)
      </label>
      {error && <div className="im-error">{error}</div>}
      {invites === null ? (
        <p>Loading…</p>
      ) : invites.length === 0 ? (
        <p className="im-admin__empty">No codes match.</p>
      ) : (
        <table className="im-admin__table">
          <thead>
            <tr>
              <th>Code</th>
              <th>Uses</th>
              <th>Expires</th>
              <th>Role</th>
              <th>Status</th>
              <th>Note</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {invites.map((r) => {
              const status = inviteStatus(r);
              const isActive = status === "active";
              return (
                <tr key={r.code}>
                  <td>
                    <code>{r.formatted}</code>
                  </td>
                  <td>
                    {r.usedCount} / {r.maxUses}
                  </td>
                  <td>{r.expiresAt ? r.expiresAt.slice(0, 10) : "never"}</td>
                  <td>{r.grantsAdmin ? "admin" : "user"}</td>
                  <td>{status}</td>
                  <td>{r.note ?? ""}</td>
                  <td>
                    {isActive && (
                      <button
                        disabled={busy}
                        onClick={() => void onRevoke(r.code)}
                      >
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function inviteStatus(r: AdminInviteRow): string {
  if (r.revokedAt) return "revoked";
  if (r.usedCount >= r.maxUses) return "exhausted";
  if (r.expiresAt !== null && r.expiresAt <= new Date().toISOString()) {
    return "expired";
  }
  return "active";
}

// ---------------------------------------------------------------------------
// Users tab
// ---------------------------------------------------------------------------

function UsersTab(): ReactNode {
  const auth = useAuth();
  const [filter, setFilter] = useState("");
  const [adminFilter, setAdminFilter] = useState<"all" | "admins" | "users">(
    "all",
  );
  const [rows, setRows] = useState<AdminUserRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setError(null);
      const opts: Parameters<typeof adminListUsers>[0] = {};
      if (filter.trim().length > 0) opts.username = filter.trim();
      if (adminFilter === "admins") opts.isAdmin = true;
      else if (adminFilter === "users") opts.isAdmin = false;
      const r = await adminListUsers(opts);
      setRows(r.users);
    } catch (e) {
      setError(e instanceof Error ? e.message : "load failed");
    }
  }, [filter, adminFilter]);

  // Debounced reload as the operator types in the filter.
  useEffect(() => {
    const t = setTimeout(() => void load(), 200);
    return () => clearTimeout(t);
  }, [load]);

  async function onToggleRole(target: AdminUserRow): Promise<void> {
    const next = !target.isAdmin;
    if (
      target.isAdmin &&
      !next &&
      !confirm(
        `Demote ${target.username} from admin? They'll lose access to this console.`,
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await adminSetUserRole({ userId: target.id, isAdmin: next });
      void load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "role change failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="im-admin__section">
      <h2>Users</h2>
      <div className="im-admin__filters">
        <input
          placeholder="Filter by username…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <select
          value={adminFilter}
          onChange={(e) =>
            setAdminFilter(e.target.value as "all" | "admins" | "users")
          }
        >
          <option value="all">All roles</option>
          <option value="admins">Admins only</option>
          <option value="users">Users only</option>
        </select>
      </div>
      {error && <div className="im-error">{error}</div>}
      {rows === null ? (
        <p>Loading…</p>
      ) : rows.length === 0 ? (
        <p className="im-admin__empty">No users match.</p>
      ) : (
        <table className="im-admin__table">
          <thead>
            <tr>
              <th>Username</th>
              <th>Role</th>
              <th>Created</th>
              <th>Last seen</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((u) => {
              const isMe = auth.user?.id === u.id;
              return (
                <tr key={u.id}>
                  <td>
                    {u.username}
                    {isMe ? " (you)" : ""}
                  </td>
                  <td>{u.isAdmin ? "admin" : "user"}</td>
                  <td>{u.createdAt.slice(0, 10)}</td>
                  <td>
                    {u.lastSeenAt ? u.lastSeenAt.slice(0, 10) : "—"}
                  </td>
                  <td>
                    <button
                      disabled={busy || isMe}
                      onClick={() => void onToggleRole(u)}
                      title={
                        isMe
                          ? "You can't change your own role here — use the CLI."
                          : u.isAdmin
                            ? "Demote to non-admin user"
                            : "Promote to admin"
                      }
                    >
                      {u.isAdmin ? "Demote" : "Promote"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
