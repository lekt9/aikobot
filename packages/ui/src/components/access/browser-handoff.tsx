/** Presents owner-authenticated browser frames with version-bound human controls.
 * Private frames stay in the mounted account scope; uncertain mutations require a fresh
 * observation and are never replayed. Text entry belongs to the credential sheet.
 */
import type {
  AccessBrowserAction,
  AccessBrowserFrame,
  AccessBrowserHandoff,
  AccessClient,
} from "access/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../ui/button";

interface BrowserHandoffProps {
  client: AccessClient;
  accountId: string;
  handoff: AccessBrowserHandoff;
  onResumed: () => Promise<void>;
}

/** Remounts private presentation whenever its authority or handoff changes. */
export function BrowserHandoff(props: BrowserHandoffProps) {
  const { client, accountId, handoff } = props;
  const capabilities = handoff.capabilities.join(",");
  const scope = useMemo(
    () => ({
      key: crypto.randomUUID(),
      client,
      accountId,
      id: handoff.id,
      status: handoff.status,
      expiresAt: handoff.expiresAt,
      capabilities,
    }),
    [
      client,
      accountId,
      handoff.id,
      handoff.status,
      handoff.expiresAt,
      capabilities,
    ],
  );
  return <BrowserSession key={scope.key} {...props} />;
}

function BrowserSession({
  client,
  accountId,
  handoff,
  onResumed,
}: BrowserHandoffProps) {
  const [frame, setFrame] = useState<AccessBrowserFrame | null>(null);
  const [loadedVersion, setLoadedVersion] = useState<number | null>(null);
  const [observation, setObservation] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(handoff.expiresAt <= Date.now());
  const [resumed, setResumed] = useState(false);
  const [resumeFailed, setResumeFailed] = useState(false);
  const active = useRef(false);
  const locked = useRef(false);
  const completed = useRef(false);
  const reader = useRef<AbortController | null>(null);
  const image = useRef<HTMLImageElement | null>(null);
  const imageRef = useCallback((element: HTMLImageElement | null) => {
    if (!element) image.current?.removeAttribute("src");
    image.current = element;
  }, []);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      reader.current?.abort();
      image.current?.removeAttribute("src");
    };
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const check = () => {
      const remaining =
        Math.min(handoff.expiresAt, frame?.expiresAt ?? handoff.expiresAt) -
        Date.now();
      if (remaining > 0) {
        timer = setTimeout(check, Math.min(remaining, 2147483647));
        return;
      }
      reader.current?.abort();
      setFrame(null);
      setLoadedVersion(null);
      if (handoff.expiresAt <= Date.now()) setExpired(true);
      else
        setError("This screen expired. Refresh the screen before continuing.");
    };
    check();
    return () => clearTimeout(timer);
  }, [handoff.expiresAt, frame]);

  const available = () =>
    active.current &&
    !completed.current &&
    handoff.status === "waiting" &&
    handoff.expiresAt > Date.now();
  const accept = (value: AccessBrowserFrame) => {
    if (!available()) return;
    if (value.handoffId !== handoff.id || value.expiresAt <= Date.now())
      throw new Error("Browser frame unavailable");
    setLoadedVersion(null);
    setObservation((value) => value + 1);
    setFrame(value);
  };
  async function perform(work: () => Promise<void>) {
    if (locked.current || !available()) return;
    locked.current = true;
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch {
      // error-policy:J4 Uncertain browser receipts hide controls until a fresh observation; no mutation is replayed.
      if (available()) {
        setFrame(null);
        setLoadedVersion(null);
        setError(
          "The browser change could not be confirmed. Refresh the screen before continuing.",
        );
      }
    } finally {
      locked.current = false;
      if (active.current) setBusy(false);
    }
  }
  const refresh = () =>
    perform(async () => {
      const controller = new AbortController();
      reader.current = controller;
      accept(
        await client.accounts.browser.frame(
          accountId,
          handoff.id,
          controller.signal,
        ),
      );
    });
  const interact = (action: AccessBrowserAction["action"]) => {
    if (
      !frame ||
      frame.expiresAt <= Date.now() ||
      loadedVersion !== frame.version ||
      !handoff.capabilities.includes(action.kind)
    )
      return;
    const version = frame.version;
    return perform(async () =>
      accept(
        await client.accounts.browser.act(accountId, handoff.id, {
          id: crypto.randomUUID(),
          version,
          action,
        }),
      ),
    );
  };
  const finish = () => {
    if (
      !frame ||
      frame.expiresAt <= Date.now() ||
      loadedVersion !== frame.version ||
      !handoff.capabilities.includes("resume")
    )
      return;
    return perform(async () => {
      const id = crypto.randomUUID();
      const receipt = await client.accounts.browser.resume(
        accountId,
        handoff.id,
        { id, version: frame.version },
      );
      if (!available()) return;
      if (
        receipt.id !== id ||
        receipt.kind !== "resume" ||
        receipt.accountId !== accountId
      )
        throw new Error("Browser resume receipt mismatch");
      completed.current = true;
      setFrame(null);
      setLoadedVersion(null);
      setResumed(true);
      setResumeFailed(
        receipt.status === "failed" || receipt.status === "cancelled",
      );
      try {
        await onResumed();
      } catch {
        // error-policy:J4 Resume was acknowledged; a failed connection refresh must never enable another resume.
        if (active.current)
          setError(
            "Verification was sent. Refresh the app connection to see its progress.",
          );
      }
    });
  };
  const unavailable = expired || handoff.status !== "waiting";
  const controlsDisabled = busy || !frame || loadedVersion !== frame.version;
  return (
    <section
      className="access-callout access-browser"
      data-agent-sensitive="true"
      aria-label="Private browser"
    >
      <h3>Continue in the private browser</h3>
      <p>{handoff.reason}</p>
      <p>
        Use the website’s controls to finish verification. Enter passwords and
        verification codes in the secure sign-in form.
      </p>
      {handoff.unsupported.includes("passkeys") && (
        <p>
          Device passkeys cannot be used in this remote browser. Choose another
          sign-in method on the website.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {resumed ? (
        <p role={resumeFailed ? "alert" : "status"}>
          {resumeFailed
            ? "Verification could not continue. Reconnect the app to try again."
            : "Verification sent. Aiko is continuing the connection."}
        </p>
      ) : unavailable ? (
        <p role="alert">
          This browser session is unavailable or expired. Reconnect the app to
          continue.
        </p>
      ) : (
        <>
          <Button
            variant="outline"
            size="touch"
            disabled={busy}
            onClick={() => void refresh()}
          >
            {busy
              ? "Updating screen…"
              : frame || error
                ? "Refresh screen"
                : "Open private browser"}
          </Button>
          {frame && (
            <>
              <p className="access-site" data-agent-sensitive="true">
                {frame.url}
              </p>
              <p className="access-browser-help">
                Tap a control on the screen, or use the keyboard buttons below
                to move focus and select.
              </p>
              <Button
                variant="mediaZoom"
                size="content"
                className="access-browser-screen"
                data-agent-sensitive="true"
                aria-label="Interact with private browser screen"
                disabled={
                  controlsDisabled || !handoff.capabilities.includes("click")
                }
                onClick={(event) => {
                  // Keyboard activation must not invent a click at an unseen coordinate.
                  if (event.detail === 0) return;
                  const bounds = image.current?.getBoundingClientRect();
                  if (!bounds || bounds.width <= 0 || bounds.height <= 0)
                    return;
                  const x = Math.floor(
                    ((event.clientX - bounds.left) * frame.width) /
                      bounds.width,
                  );
                  const y = Math.floor(
                    ((event.clientY - bounds.top) * frame.height) /
                      bounds.height,
                  );
                  if (x < 0 || y < 0 || x >= frame.width || y >= frame.height)
                    return;
                  void interact({ kind: "click", x, y });
                }}
              >
                <img
                  ref={imageRef}
                  key={observation}
                  src={`data:image/png;base64,${frame.image.base64}`}
                  width={frame.width}
                  height={frame.height}
                  alt="Private website screen"
                  data-agent-sensitive="true"
                  draggable={false}
                  onLoad={() => setLoadedVersion(frame.version)}
                  onError={() => {
                    setFrame(null);
                    setLoadedVersion(null);
                    setError(
                      "The private screen could not be displayed. Refresh the screen to try again.",
                    );
                  }}
                />
              </Button>
              {loadedVersion !== frame.version && (
                <p role="status">Loading private screen…</p>
              )}
              <fieldset
                className="access-browser-controls"
                aria-label="Private browser controls"
              >
                {handoff.capabilities.includes("scroll") && (
                  <>
                    <Button
                      variant="outline"
                      size="touch"
                      data-agent-sensitive="true"
                      disabled={controlsDisabled}
                      onClick={() =>
                        void interact({ kind: "scroll", dx: 0, dy: -500 })
                      }
                    >
                      Scroll up
                    </Button>
                    <Button
                      variant="outline"
                      size="touch"
                      data-agent-sensitive="true"
                      disabled={controlsDisabled}
                      onClick={() =>
                        void interact({ kind: "scroll", dx: 0, dy: 500 })
                      }
                    >
                      Scroll down
                    </Button>
                  </>
                )}
                {handoff.capabilities.includes("press") &&
                  (["Tab", "Enter", "Escape", "Space"] as const).map((key) => (
                    <Button
                      key={key}
                      variant="outline"
                      size="touch"
                      data-agent-sensitive="true"
                      disabled={controlsDisabled}
                      onClick={() => void interact({ kind: "press", key })}
                    >
                      {key}
                    </Button>
                  ))}
                {handoff.capabilities.includes("resume") && (
                  <Button
                    variant="accentDarkHover"
                    size="touch"
                    className="access-primary"
                    data-agent-sensitive="true"
                    disabled={controlsDisabled}
                    onClick={() => void finish()}
                  >
                    Finished verification
                  </Button>
                )}
              </fieldset>
            </>
          )}
        </>
      )}
    </section>
  );
}
