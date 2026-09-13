/** Mounts the account drawer with the existing app session and follows committed Access events while the view is open. */
import { client } from "@elizaos/ui/api";
import { AppsDrawer } from "@elizaos/ui/components/access";
import "@elizaos/ui/components/access/access.css";
import React, {
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { createAccessAppClient } from "./access-client";
import type { EmbedAuthOutcome } from "./embed-bootstrap";
import { telegramWebApp } from "./telegram-webapp.js";

const subscribeAuthority = (listener: () => void) =>
  client.onAuthorityChange(listener);
const authorityRevision = () => client.getAuthorityRevision();

export function AccessMiniApp() {
  const authority = useSyncExternalStore(
    subscribeAuthority,
    authorityRevision,
    authorityRevision,
  );
  if (!client.getRestAuthToken())
    return (
      <main>
        <h1>Connect your apps</h1>
        <p role="alert">Sign in to open your connected apps.</p>
      </main>
    );
  return <AccessSessionDrawer key={authority} />;
}

function AccessSessionDrawer() {
  const access = useMemo(
    () => createAccessAppClient(client, window.location.origin),
    [],
  );
  const [refreshKey, setRefreshKey] = useState(0);
  const [eventError, setEventError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let cursor = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const follow = async () => {
      if (controller.signal.aborted) return;
      try {
        if (document.visibilityState !== "hidden") {
          let more = true;
          while (more && !controller.signal.aborted) {
            const page = await access.events(cursor, controller.signal);
            if (controller.signal.aborted) return;
            if (page.events.length > 0) setRefreshKey((value) => value + 1);
            if (page.hasMore && page.nextCursor <= cursor)
              throw new Error("Access event cursor did not advance");
            cursor = page.nextCursor;
            more = page.hasMore;
          }
          setEventError(false);
        }
      } catch {
        // error-policy:J4 A disconnected view visibly reports delayed progress and resumes at its last cursor.
        if (!controller.signal.aborted) setEventError(true);
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(follow, 1500);
      }
    };
    void follow();
    return () => {
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [access]);
  return (
    <>
      {eventError && (
        <p role="status">Connection updates are delayed. Reconnecting…</p>
      )}
      <AppsDrawer client={access} refreshKey={refreshKey} />
    </>
  );
}

/** A failed Telegram launch cannot fall through into a previously authenticated account drawer. */
export function AccessEmbedApp({
  authentication,
}: {
  authentication: EmbedAuthOutcome;
}) {
  React.useEffect(() => {
    const telegram = telegramWebApp(window);
    telegram?.ready?.();
    telegram?.expand?.();
  }, []);
  if (authentication.status !== "authenticated") {
    return (
      <main>
        <h1>Connect your apps</h1>
        <p role="alert">
          {authentication.status === "failed" &&
          authentication.reason.startsWith("telegram_sdk_")
            ? "Telegram could not load. Close and reopen this app to try again."
            : "Open this app from Aiko in Telegram to sign in."}
        </p>
      </main>
    );
  }
  return <AccessMiniApp />;
}
