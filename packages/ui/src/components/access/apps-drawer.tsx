/**
 * Account drawer for authenticated Access clients in Telegram and the app host.
 * The host owns authentication and committed-event subscription; refreshKey
 * refreshes projections without introducing a scheduler or another bot loop.
 */
import type {
  AccessClient,
  AccessConnection,
  RemoteAccount,
} from "access/client";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { BrowserHandoff } from "./browser-handoff";
import { CredentialForm } from "./credential-form";

export interface AppsDrawerProps {
  client: AccessClient;
  onClose?: () => void;
  /** Change after the host receives committed Access events. */
  refreshKey?: number;
}
type Load<T> =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; value: T };
const statusLabels: Record<AccessConnection["status"], string> = {
  not_connected: "Ready to connect",
  connecting: "Connecting",
  credentials_required: "Sign-in needed",
  verification_required: "Verification needed",
  connected: "Connected",
  reconnect_required: "Reconnect needed",
  unavailable: "Unavailable",
  revoked: "Access removed",
};

/** Only website origins are accepted; embedded credentials never become account metadata. */
export function websiteOrigin(value: string): string | null {
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== "/" && url.pathname !== "")
    )
      return null;
    return url.origin;
  } catch {
    // error-policy:J3 Invalid website input has no usable origin.
    return null;
  }
}

function AppIcon({ site }: { site: string }) {
  const [failed, setFailed] = useState(false);
  const origin = websiteOrigin(site);
  return (
    <span className="access-app-icon" aria-hidden="true">
      {!failed && origin ? (
        <img
          src={`${origin}/favicon.ico`}
          alt=""
          referrerPolicy="no-referrer"
          loading="lazy"
          onError={() => setFailed(true)}
        />
      ) : (
        <span>↗</span>
      )}
    </span>
  );
}

export function AppsDrawer({
  client,
  onClose,
  refreshKey = 0,
}: AppsDrawerProps) {
  const [accounts, setAccounts] = useState<Load<RemoteAccount[]>>({
    status: "loading",
  });
  const [selected, setSelected] = useState<RemoteAccount | null>(null);
  const [adding, setAdding] = useState(false);
  const [revision, setRevision] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Explicit refresh and committed event revisions invalidate the account projection.
  useEffect(() => {
    let active = true;
    setAccounts({ status: "loading" });
    client.accounts.list().then(
      ({ accounts: items }) => {
        if (active) setAccounts({ status: "ready", value: items });
      },
      () => {
        // error-policy:J1 The drawer presents unavailable data distinctly from an empty account list.
        if (active) setAccounts({ status: "error" });
      },
    );
    return () => {
      active = false;
    };
  }, [client, refreshKey, revision]);
  const refresh = () => setRevision((value) => value + 1);
  return (
    <section
      className="access-apps"
      aria-label="Connected apps"
      data-scroll-cert-scroller
    >
      <header className="access-header">
        <div>
          <p className="access-eyebrow">AIKO · YOUR CONNECTIONS</p>
          <h1>Your apps</h1>
          <p className="access-muted">
            Connect the places you use. Aiko takes it from there.
          </p>
        </div>
        {onClose && (
          <Button variant="outline" onClick={onClose}>
            Back to chat
          </Button>
        )}
      </header>
      <div className="access-drawer-heading">
        <h2>App drawer</h2>
        <Button variant="outline" onClick={refresh}>
          Refresh
        </Button>
      </div>
      {accounts.status === "loading" && (
        <p role="status" className="access-empty">
          Loading your apps…
        </p>
      )}
      {accounts.status === "error" && (
        <div role="alert" className="access-empty">
          <h3>Your apps could not be loaded</h3>
          <p>Check your connection, then refresh.</p>
        </div>
      )}
      {accounts.status === "ready" && (
        <>
          <div className="access-app-grid">
            {accounts.value.map((account) => (
              <Button
                key={account.id}
                variant="outline"
                className="access-app-tile"
                onClick={() => setSelected(account)}
              >
                <AppIcon site={account.site} />
                <span className="access-app-name">
                  {account.label || account.site}
                </span>
                <span className="access-tile-status">
                  {account.active ? "Open connection" : "Access removed"}
                </span>
              </Button>
            ))}
            <Button
              variant="outline"
              className="access-app-tile access-add-tile"
              onClick={() => setAdding(true)}
            >
              <span className="access-app-icon" aria-hidden="true">
                +
              </span>
              <span className="access-app-name">Add an app</span>
              <span className="access-tile-status">Enter a website</span>
            </Button>
          </div>
          {accounts.value.length === 0 && (
            <div className="access-empty">
              <h3>A place for the apps in your day</h3>
              <p>
                Add a website to connect your first account. You choose what
                Aiko can do.
              </p>
            </div>
          )}
        </>
      )}
      <p className="access-vault-note">
        Private logins. Separate accounts. You stay in control.
      </p>
      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent className="access-sheet" showCloseButton={false}>
          <DialogTitle>Add an app</DialogTitle>
          <DialogDescription>
            Start with its website. Aiko will find the sign-in steps.
          </DialogDescription>
          <AddApp
            client={client}
            onCancel={() => setAdding(false)}
            onAdded={(account) => {
              setAdding(false);
              setSelected(account);
              refresh();
            }}
          />
        </DialogContent>
      </Dialog>
      <Dialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <DialogContent className="access-sheet" showCloseButton={false}>
          <DialogTitle>
            {selected?.label || selected?.site || "App connection"}
          </DialogTitle>
          <DialogDescription>
            Manage this account’s connection and permissions.
          </DialogDescription>
          {selected && (
            <AccountDetail
              key={`${selected.id}-${selected.active}`}
              client={client}
              account={selected}
              refreshKey={refreshKey}
              onClose={() => setSelected(null)}
              onChanged={refresh}
            />
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}

function AddApp({
  client,
  onAdded,
  onCancel,
}: {
  client: AccessClient;
  onAdded: (account: RemoteAccount) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [site, setSite] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const operation = useRef(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (operation.current) return;
    const origin = websiteOrigin(site.trim());
    if (!origin) {
      setError(
        "Enter an HTTPS website address without a path, password, or query.",
      );
      return;
    }
    operation.current = true;
    setBusy(true);
    setError(null);
    try {
      const { account } = await client.accounts.add({
        id: crypto.randomUUID(),
        site: origin,
        label: label.trim() || new URL(origin).hostname,
      });
      onAdded(account);
    } catch {
      // error-policy:J1 Account creation errors are rendered without remote request diagnostics.
      setError(
        "The app could not be added. Refresh your apps before trying again.",
      );
    } finally {
      operation.current = false;
      setBusy(false);
    }
  }
  return (
    <form className="access-form" onSubmit={submit}>
      <div className="access-field">
        <Label htmlFor={`${id}-site`}>Website</Label>
        <Input
          id={`${id}-site`}
          placeholder="example.com"
          autoCapitalize="none"
          autoComplete="url"
          required
          value={site}
          onChange={(event) => setSite(event.target.value)}
          disabled={busy}
        />
      </div>
      <div className="access-field">
        <Label htmlFor={`${id}-label`}>Account name (optional)</Label>
        <Input
          id={`${id}-label`}
          placeholder="Personal or work"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          disabled={busy}
        />
      </div>
      {error && <p role="alert">{error}</p>}
      <div className="access-actions">
        <Button
          type="submit"
          variant="accentDarkHover"
          className="access-primary"
          disabled={busy}
        >
          {busy ? "Adding…" : "Add app"}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function AccountDetail({
  client,
  account,
  refreshKey,
  onClose,
  onChanged,
}: {
  client: AccessClient;
  account: RemoteAccount;
  refreshKey: number;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [connection, setConnection] = useState<Load<AccessConnection>>({
    status: "loading",
  });
  const [label, setLabel] = useState(account.label);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const id = useId();
  const operation = useRef(false);
  const generation = useRef(0);
  const reload = useCallback(async () => {
    const current = ++generation.current;
    try {
      const value = await client.accounts.connection(account.id);
      if (current === generation.current)
        setConnection({ status: "ready", value });
    } catch {
      // error-policy:J1 A failed projection refresh remains visibly unavailable.
      if (current === generation.current) setConnection({ status: "error" });
    }
  }, [client, account.id]);
  useEffect(() => {
    void refreshKey;
    void reload();
    return () => {
      generation.current += 1;
    };
  }, [reload, refreshKey]);
  useEffect(() => {
    const foreground = () => {
      if (document.visibilityState === "visible") void reload();
    };
    window.addEventListener("focus", foreground);
    document.addEventListener("visibilitychange", foreground);
    return () => {
      window.removeEventListener("focus", foreground);
      document.removeEventListener("visibilitychange", foreground);
    };
  }, [reload]);
  async function perform(action: () => Promise<void>) {
    if (operation.current) return;
    operation.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
      await reload();
      onChanged();
    } catch {
      // error-policy:J1 Mutations are not retried automatically; users can inspect committed state first.
      setError(
        "This change could not be confirmed. Refresh the connection before trying again.",
      );
    } finally {
      operation.current = false;
      setBusy(false);
    }
  }
  const value = connection.status === "ready" ? connection.value : null;
  const pending = value?.pending;
  const handoff = value?.handoff;
  return (
    <div className="access-detail">
      <div className="access-connection-banner">
        <AppIcon site={account.site} />
        <div>
          <p className="access-site">{account.site}</p>
          <p
            role="status"
            className="access-status"
            data-connected={value?.status === "connected"}
          >
            {connection.status === "loading"
              ? "Loading connection…"
              : connection.status === "error"
                ? "Connection unavailable"
                : statusLabels[connection.value.status]}
          </p>
        </div>
      </div>
      <div className="access-actions">
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => {
            void reload();
          }}
        >
          Refresh connection
        </Button>
        <Button variant="outline" onClick={onClose}>
          Close
        </Button>
      </div>
      {connection.status === "error" && (
        <p role="alert">
          Connection details could not be loaded. Refresh to try again.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {value && (
        <>
          {value.error !== null && (
            <p role="alert">
              The connection needs attention. Reconnect or refresh to continue.
            </p>
          )}
          {value.verifiedAt !== null && (
            <p className="access-muted">
              Last verified {new Date(value.verifiedAt).toLocaleString()}
            </p>
          )}
          {["not_connected", "reconnect_required", "unavailable"].includes(
            value.status,
          ) && (
            <Button
              variant="accentDarkHover"
              className="access-primary"
              disabled={busy}
              onClick={() => {
                void perform(async () => {
                  await client.accounts.submit(account.id, {
                    id: crypto.randomUUID(),
                    kind: "connect",
                  });
                });
              }}
            >
              {value.status === "not_connected"
                ? "Connect account"
                : "Reconnect account"}
            </Button>
          )}
          {value.status === "connecting" && (
            <p className="access-muted">
              Aiko is opening the website and checking the sign-in steps. Keep
              this screen open for any details needed.
            </p>
          )}
          {pending && (
            <CredentialForm
              accountSite={account.site}
              key={pending.id}
              request={pending}
              onCancel={onClose}
              onSubmit={async (values) => {
                await client.accounts.credentials.fulfill(
                  account.id,
                  pending.id,
                  values,
                );
                const waiting = value.operations.filter(
                  (item) => item.status === "waiting_credentials",
                );
                for (const item of waiting)
                  await client.accounts.submit(account.id, {
                    id: crypto.randomUUID(),
                    kind: "resume",
                    operationId: item.id,
                  });
                await reload();
                onChanged();
              }}
            />
          )}
          {handoff && (
            <BrowserHandoff
              key={`${account.id}:${handoff.id}`}
              client={client}
              accountId={account.id}
              handoff={handoff}
              onResumed={async () => {
                await reload();
                onChanged();
              }}
            />
          )}
          {value.approvals
            .filter((item) => item.status === "pending")
            .map((approval) => (
              <section
                className="access-callout"
                key={approval.id}
                aria-label="Permission request"
              >
                <h3>Aiko needs your permission</h3>
                <p className="access-preserve-text">{approval.description}</p>
                <div className="access-actions">
                  <Button
                    variant="accentDarkHover"
                    className="access-primary"
                    disabled={busy || approval.expiresAt <= Date.now()}
                    onClick={() => {
                      void perform(async () => {
                        await client.accounts.approve(
                          account.id,
                          approval.id,
                          "approved",
                          approval.effectDigest,
                        );
                      });
                    }}
                  >
                    Allow this action
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy || approval.expiresAt <= Date.now()}
                    onClick={() => {
                      void perform(async () => {
                        await client.accounts.approve(
                          account.id,
                          approval.id,
                          "denied",
                          approval.effectDigest,
                        );
                      });
                    }}
                  >
                    Deny
                  </Button>
                </div>
                {approval.expiresAt <= Date.now() && (
                  <p role="alert">
                    This permission request expired. Refresh to continue.
                  </p>
                )}
              </section>
            ))}
          {value.operations.length > 0 && (
            <section className="access-activity">
              <h3>Connection activity</h3>
              <ul>
                {value.operations.map((item) => (
                  <li key={item.id}>
                    <span>
                      {item.kind === "connect"
                        ? "Account sign-in"
                        : item.kind === "resume"
                          ? "Continue task"
                          : item.kind === "synthesize"
                            ? "Learn an app task"
                            : item.kind === "refresh"
                              ? "Refresh app information"
                              : "App task"}
                    </span>
                    <span>{item.status.replaceAll("_", " ")}</span>
                    {item.status === "waiting_credentials" &&
                      pending === null && (
                        <Button
                          variant="outline"
                          disabled={busy}
                          onClick={() => {
                            void perform(async () => {
                              await client.accounts.submit(account.id, {
                                id: crypto.randomUUID(),
                                kind: "resume",
                                operationId: item.id,
                              });
                            });
                          }}
                        >
                          Continue task
                        </Button>
                      )}
                  </li>
                ))}
              </ul>
            </section>
          )}
          <form
            className="access-form"
            onSubmit={(event) => {
              event.preventDefault();
              void perform(async () => {
                await client.accounts.rename(account.id, label.trim());
              });
            }}
          >
            <div className="access-field">
              <Label htmlFor={`${id}-name`}>Account name</Label>
              <Input
                id={`${id}-name`}
                value={label}
                required
                disabled={busy || value.status === "revoked"}
                onChange={(event) => setLabel(event.target.value)}
              />
            </div>
            <Button
              type="submit"
              variant="outline"
              disabled={busy || !label.trim() || value.status === "revoked"}
            >
              Save name
            </Button>
          </form>
          {value.status !== "revoked" && (
            <div className="access-remove">
              {confirmRevoke ? (
                <>
                  <p>
                    Remove Aiko’s access to this account and its saved session?
                  </p>
                  <div className="access-actions">
                    <Button
                      variant="dangerOutline"
                      disabled={busy}
                      onClick={() => {
                        void perform(async () => {
                          await client.accounts.revoke(account.id);
                          onClose();
                        });
                      }}
                    >
                      Remove access
                    </Button>
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => setConfirmRevoke(false)}
                    >
                      Keep connected
                    </Button>
                  </div>
                </>
              ) : (
                <Button
                  variant="dangerGhost"
                  disabled={busy}
                  onClick={() => setConfirmRevoke(true)}
                >
                  Remove this connection
                </Button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
