/**
 * Loads Telegram's official WebApp SDK for the Apps embed before launch-data
 * detection. Script readiness is never authentication; signed initData still
 * goes through the existing server handshake. Failed attempts can be retried.
 */
export const TELEGRAM_WEBAPP_SCRIPT =
  "https://telegram.org/js/telegram-web-app.js?63";

export interface TelegramWebApp {
  initData: string;
  ready?: () => void;
  expand?: () => void;
}

type TelegramSdkOutcome =
  | { status: "ready" }
  | {
      status: "failed";
      reason:
        | "telegram_sdk_load_failed"
        | "telegram_sdk_timeout"
        | "telegram_sdk_unavailable";
    };

const loading = new WeakMap<Window, Promise<TelegramSdkOutcome>>();

export function telegramWebApp(win: Window): TelegramWebApp | null {
  const app = (win as Window & { Telegram?: { WebApp?: TelegramWebApp } })
    .Telegram?.WebApp;
  return app && typeof app.initData === "string" ? app : null;
}

/** Sibling application and Discord routes must not download a Telegram SDK. */
export function isTelegramAppsEmbed(win: Window): boolean {
  const path = win.location.pathname;
  if (path !== "/embed/apps" && !path.startsWith("/embed/apps/")) return false;
  const params = new URLSearchParams(win.location.search);
  const platform = params.get("platform");
  if (platform !== null) return platform === "telegram";
  return !params.has("code");
}

/** Concurrent callers share one script attempt; errors and timeouts remove it. */
export function ensureTelegramWebApp(
  win: Window,
  timeoutMs = 10_000,
): Promise<TelegramSdkOutcome> {
  if (telegramWebApp(win)) return Promise.resolve({ status: "ready" });
  const existing = loading.get(win);
  if (existing) return existing;
  const promise = new Promise<TelegramSdkOutcome>((resolve) => {
    let script: HTMLScriptElement | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = (outcome: TelegramSdkOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (script) {
        script.onload = null;
        script.onerror = null;
        if (outcome.status === "failed") script.remove();
      }
      resolve(outcome);
    };
    try {
      script = win.document.createElement("script");
      script.src = TELEGRAM_WEBAPP_SCRIPT;
      script.async = true;
      script.referrerPolicy = "no-referrer";
      script.dataset.elizaTelegramWebappSdk = "true";
      script.onload = () =>
        finish(
          telegramWebApp(win)
            ? { status: "ready" }
            : { status: "failed", reason: "telegram_sdk_unavailable" },
        );
      script.onerror = () =>
        finish({ status: "failed", reason: "telegram_sdk_load_failed" });
      timer = setTimeout(
        () => finish({ status: "failed", reason: "telegram_sdk_timeout" }),
        timeoutMs,
      );
      win.document.head.append(script);
    } catch {
      // error-policy:J1 DOM or CSP setup failures become a visible embed failure without diagnostic payloads.
      finish({ status: "failed", reason: "telegram_sdk_unavailable" });
    }
  });
  loading.set(win, promise);
  void promise.then(() => {
    if (loading.get(win) === promise) loading.delete(win);
  });
  return promise;
}
