/** Exercises the real DOM script loader and embed handshake with controlled script events and HTTP responses. */
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { runEmbedHandshake } from "./embed-bootstrap.js";
import {
  ensureTelegramWebApp,
  TELEGRAM_WEBAPP_SCRIPT,
} from "./telegram-webapp.js";

function installSdk(initData = "query_id=fixture&hash=signed-fixture") {
  Object.defineProperty(window, "Telegram", {
    configurable: true,
    value: { WebApp: { initData } },
  });
}

function script() {
  const element = document.querySelector<HTMLScriptElement>(
    "script[data-eliza-telegram-webapp-sdk]",
  );
  if (!element)
    throw new Error("Expected the Telegram SDK script to be attached");
  return element;
}

afterEach(() => {
  Reflect.deleteProperty(window, "Telegram");
  for (const element of document.querySelectorAll(
    "script[data-eliza-telegram-webapp-sdk]",
  ))
    element.remove();
  window.history.replaceState(null, "", "/");
});

describe("Telegram SDK loading", () => {
  it("shares a single official script across concurrent callers and reuses the loaded SDK", async () => {
    const first = ensureTelegramWebApp(window);
    const second = ensureTelegramWebApp(window);
    expect(
      document.querySelectorAll("script[data-eliza-telegram-webapp-sdk]"),
    ).toHaveLength(1);
    expect(script().src).toBe(TELEGRAM_WEBAPP_SCRIPT);
    expect(script().referrerPolicy).toBe("no-referrer");
    installSdk();
    script().dispatchEvent(new Event("load"));
    expect(await Promise.all([first, second])).toEqual([
      { status: "ready" },
      { status: "ready" },
    ]);
    expect(await ensureTelegramWebApp(window)).toEqual({ status: "ready" });
    expect(
      document.querySelectorAll("script[data-eliza-telegram-webapp-sdk]"),
    ).toHaveLength(1);
  });

  it("removes a failed attempt and allows a new successful attempt", async () => {
    const failed = ensureTelegramWebApp(window);
    const original = script();
    original.dispatchEvent(new Event("error"));
    expect(await failed).toEqual({
      status: "failed",
      reason: "telegram_sdk_load_failed",
    });
    expect(original.isConnected).toBe(false);
    const retry = ensureTelegramWebApp(window);
    expect(script()).not.toBe(original);
    installSdk();
    script().dispatchEvent(new Event("load"));
    expect(await retry).toEqual({ status: "ready" });
  });

  it("times out without a ready event and allows retry without the abandoned script", async () => {
    const failed = ensureTelegramWebApp(window, 5);
    const original = script();
    expect(await failed).toEqual({
      status: "failed",
      reason: "telegram_sdk_timeout",
    });
    expect(original.isConnected).toBe(false);
    const retry = ensureTelegramWebApp(window);
    installSdk();
    script().dispatchEvent(new Event("load"));
    expect(await retry).toEqual({ status: "ready" });
  });

  it("rejects a load event without the SDK object instead of pretending initialization succeeded", async () => {
    const result = ensureTelegramWebApp(window);
    script().dispatchEvent(new Event("load"));
    expect(await result).toEqual({
      status: "failed",
      reason: "telegram_sdk_unavailable",
    });
    expect(
      document.querySelector("script[data-eliza-telegram-webapp-sdk]"),
    ).toBeNull();
  });
});

describe("Telegram Apps embed bootstrap", () => {
  it("loads the SDK before detecting a bare Apps launch and exchanges the complete signed payload", async () => {
    window.history.replaceState(
      null,
      "",
      "/embed/apps#tgWebAppData=launch-fixture",
    );
    const calls: string[] = [];
    const tokens: (string | null)[] = [];
    const payload =
      "query_id=full-fixture&user=%7B%22id%22%3A123%7D&hash=signed-fixture";
    const result = runEmbedHandshake({
      win: window,
      client: {
        getBaseUrl: () => "https://agent.example",
        getRestAuthToken: () => tokens.at(-1) ?? null,
        getAuthorityRevision: () => tokens.length,
        setToken: (token) => tokens.push(token),
      },
      fetchImpl: async (_input, init) => {
        calls.push(String(init?.body));
        return Response.json({
          token: "verified-fixture",
          role: "OWNER",
          adminMode: true,
        });
      },
    });
    expect(calls).toHaveLength(0);
    installSdk(payload);
    script().dispatchEvent(new Event("load"));
    expect(await result).toEqual({
      status: "authenticated",
      role: "OWNER",
      adminMode: true,
    });
    expect(JSON.parse(calls[0])).toEqual({
      platform: "telegram",
      signedLaunchPayload: payload,
    });
    expect(tokens).toEqual(["verified-fixture"]);
  });

  it("returns visible SDK failures without exchanging credentials or installing a token", async () => {
    window.history.replaceState(null, "", "/embed/apps");
    let exchanges = 0;
    const tokens: (string | null)[] = [];
    const result = runEmbedHandshake({
      win: window,
      client: {
        getBaseUrl: () => "https://agent.example",
        getRestAuthToken: () => tokens.at(-1) ?? null,
        getAuthorityRevision: () => tokens.length,
        setToken: (token) => tokens.push(token),
      },
      fetchImpl: async () => {
        exchanges += 1;
        return Response.json({ token: "unexpected" });
      },
    });
    script().dispatchEvent(new Event("error"));
    expect(await result).toEqual({
      status: "failed",
      reason: "telegram_sdk_load_failed",
    });
    expect(exchanges).toBe(0);
    expect(tokens).toHaveLength(0);
  });

  it("returns a timeout outcome before authentication when the script never loads", async () => {
    window.history.replaceState(null, "", "/embed/apps");
    const result = await runEmbedHandshake({
      win: window,
      telegramSdkTimeoutMs: 5,
    });
    expect(result).toEqual({
      status: "failed",
      reason: "telegram_sdk_timeout",
    });
  });

  it("never downloads Telegram on sibling routes or explicit Discord launches", async () => {
    for (const path of [
      "/apps/access",
      "/embed/discord?code=fixture&state=fixture",
      "/embed/apps?platform=discord&code=fixture&state=fixture",
      "/embed/apps?code=fixture&state=fixture",
      "/embed/apps?platform=slack",
      "/embed/apps-other",
    ]) {
      window.history.replaceState(null, "", path);
      await runEmbedHandshake({ win: window });
      expect(
        document.querySelector("script[data-eliza-telegram-webapp-sdk]"),
      ).toBeNull();
    }
  });

  it("never authenticates from initDataUnsafe or a loaded SDK with empty signed data", async () => {
    window.history.replaceState(null, "", "/embed/apps?platform=telegram");
    Object.defineProperty(window, "Telegram", {
      configurable: true,
      value: {
        WebApp: { initData: "", initDataUnsafe: { user: { id: 123 } } },
      },
    });
    let exchanges = 0;
    const result = await runEmbedHandshake({
      win: window,
      fetchImpl: async () => {
        exchanges += 1;
        return Response.json({ token: "unexpected" });
      },
    });
    expect(result).toEqual({
      status: "failed",
      reason: "missing_launch_payload",
    });
    expect(exchanges).toBe(0);
  });
});
