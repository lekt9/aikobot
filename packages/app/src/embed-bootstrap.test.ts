/**
 * Tests for the `/embed` bootstrap handshake (`isEmbedPath` + `runEmbedHandshake`)
 * that authenticates Telegram Mini App / Discord Activity embeds: it detects the
 * platform (explicit `?platform=` or auto-detected from SDK-provided Telegram
 * initData or a Discord `?code=` redirect), POSTs the signed launch payload to
 * `<base>/api/embed/auth`, and installs the returned token on the client.
 * The suite drives the real handshake and pinned ElizaClient setter, with
 * deterministic fetch/window boundaries. It asserts failure on unknown
 * platform, missing payload/OAuth state, non-2xx responses, token-less bodies,
 * network errors, and timeouts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ElizaClient } from "../../ui/src/api/client-base";
import { savePersistedActiveServer } from "../../ui/src/state/persistence";
import {
  type EmbedClient,
  isEmbedPath,
  runEmbedHandshake,
} from "./embed-bootstrap.js";

const BASE = "https://agent.example";

function fakeClient() {
  let currentToken: string | null = null;
  let revision = 0;
  const setToken = vi.fn((token: string | null) => {
    currentToken = token;
    revision += 1;
  });
  const client: EmbedClient = {
    getBaseUrl: () => BASE,
    getRestAuthToken: () => currentToken,
    getAuthorityRevision: () => revision,
    setToken,
  };
  return { client, setToken };
}

function fakeFetch(response: Response | Error) {
  return vi.fn((_url: string, _init?: RequestInit): Promise<Response> => {
    if (response instanceof Error) return Promise.reject(response);
    return Promise.resolve(response);
  });
}

function fakeWin(
  pathname: string,
  search = "",
  telegramInitData?: string,
): Window {
  return {
    location: { pathname, search },
    ...(telegramInitData !== undefined
      ? { Telegram: { WebApp: { initData: telegramInitData, ready: vi.fn() } } }
      : {}),
  } as unknown as Window;
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe("isEmbedPath", () => {
  it("matches /embed and subpaths only", () => {
    expect(isEmbedPath("/embed")).toBe(true);
    expect(isEmbedPath("/embed/telegram")).toBe(true);
    expect(isEmbedPath("/")).toBe(false);
    expect(isEmbedPath("/embedded")).toBe(false);
  });
});

describe("runEmbedHandshake", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("fails when a pinned real client rejects the exchanged owner's token", async () => {
    vi.stubGlobal("__ELIZA_BUILD_CONFIGURED_REMOTE_API_BASE__", BASE);
    savePersistedActiveServer({
      id: "remote:embed-test",
      kind: "remote",
      label: "Embed test",
      apiBase: BASE,
      accessToken: "existing-owner-token",
    });
    const client = new ElizaClient(BASE, "existing-owner-token");
    expect(client.getRestAuthToken()).toBe("existing-owner-token");
    const outcome = await runEmbedHandshake({
      win: fakeWin("/embed/apps", "?platform=telegram", "signed-launch"),
      client,
      fetchImpl: async () => Response.json({ token: "launch-owner-token" }),
    });
    expect(outcome).toEqual({
      status: "failed",
      reason: "token_not_installed",
    });
    expect(client.getRestAuthToken()).toBe("existing-owner-token");
  });

  it("fails when a client refuses token installation", async () => {
    const { client, setToken } = fakeClient();
    setToken.mockImplementation(() => undefined);
    const outcome = await runEmbedHandshake({
      win: fakeWin("/embed", "?platform=telegram", "signed-launch"),
      client,
      fetchImpl: async () => Response.json({ token: "launch-owner-token" }),
    });
    expect(outcome).toEqual({
      status: "failed",
      reason: "token_not_installed",
    });
  });

  it("does not expose a token installation error as authentication success", async () => {
    const { client, setToken } = fakeClient();
    setToken.mockImplementation(() => {
      throw new Error("private installation failure");
    });
    const outcome = await runEmbedHandshake({
      win: fakeWin("/embed", "?platform=telegram", "signed-launch"),
      client,
      fetchImpl: async () => Response.json({ token: "launch-owner-token" }),
    });
    expect(outcome).toEqual({
      status: "failed",
      reason: "token_install_failed",
    });
  });

  it.each(["owner", "server"])(
    "does not install an old exchange token after a %s change while reading the response",
    async (change) => {
      const { client, setToken } = fakeClient();
      let base = BASE;
      client.getBaseUrl = () => base;
      const outcome = await runEmbedHandshake({
        win: fakeWin("/embed", "?platform=telegram", "signed-launch"),
        client,
        fetchImpl: async () => {
          const response = Response.json({ token: "old-exchange-token" });
          response.json = async () => {
            if (change === "owner") client.setToken("new-owner-token");
            else base = "https://other-agent.example";
            return { token: "old-exchange-token" };
          };
          return response;
        },
      });
      expect(outcome).toEqual({
        status: "failed",
        reason: "authority_changed",
      });
      expect(setToken).not.toHaveBeenCalledWith("old-exchange-token");
    },
  );

  it("is a no-op off the /embed route", async () => {
    const fetchImpl = fakeFetch(jsonResponse(200, {}));
    const { client, setToken } = fakeClient();
    const outcome = await runEmbedHandshake({
      win: fakeWin("/"),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      client,
    });
    expect(outcome).toEqual({ status: "not-embed" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(setToken).not.toHaveBeenCalled();
  });

  it("fails closed on an unknown platform", async () => {
    const outcome = await runEmbedHandshake({
      win: fakeWin("/embed", "?platform=slack"),
      client: fakeClient().client,
    });
    expect(outcome).toEqual({ status: "failed", reason: "unknown_platform" });
  });

  it("fails when the telegram initData is missing", async () => {
    const outcome = await runEmbedHandshake({
      win: fakeWin("/embed", "?platform=telegram"),
      client: fakeClient().client,
    });
    expect(outcome).toEqual({
      status: "failed",
      reason: "missing_launch_payload",
    });
  });

  it("exchanges a telegram initData payload and installs the token", async () => {
    const { client, setToken } = fakeClient();
    const fetchImpl = fakeFetch(
      jsonResponse(200, {
        entityId: "e1",
        role: "OWNER",
        adminMode: true,
        token: "embed-token-abc",
      }),
    );
    const outcome = await runEmbedHandshake({
      win: fakeWin(
        "/embed",
        "?platform=telegram&accountId=acct-1",
        "tg-init-data",
      ),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      client,
    });
    expect(outcome).toEqual({
      status: "authenticated",
      role: "OWNER",
      adminMode: true,
    });
    expect(setToken).toHaveBeenCalledWith("embed-token-abc");
    // POSTs the verified launch to the agent's embed-auth route.
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${BASE}/api/embed/auth`);
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("error");
    expect(init?.cache).toBe("no-store");
    expect(JSON.parse(String(init?.body))).toEqual({
      platform: "telegram",
      signedLaunchPayload: "tg-init-data",
      accountId: "acct-1",
    });
  });

  it("preserves signed launch bytes and leaves Apps readiness to the mounted UI", async () => {
    let readyCalls = 0;
    const win = fakeWin(
      "/embed/apps",
      "?platform=telegram",
      "  exact-signed-payload  ",
    );
    Object.assign(win, {
      Telegram: {
        WebApp: {
          initData: "  exact-signed-payload  ",
          ready: () => {
            readyCalls += 1;
          },
        },
      },
    });
    const calls: string[] = [];
    const { client } = fakeClient();
    await runEmbedHandshake({
      win,
      client,
      fetchImpl: async (_url, init) => {
        calls.push(String(init?.body));
        return Response.json({ token: "fixture" });
      },
    });
    expect(JSON.parse(calls[0]).signedLaunchPayload).toBe(
      "  exact-signed-payload  ",
    );
    expect(readyCalls).toBe(0);
  });

  it("exchanges a discord Activity code from the query string", async () => {
    const { client } = fakeClient();
    const fetchImpl = fakeFetch(
      jsonResponse(200, { role: "ADMIN", adminMode: true, token: "t" }),
    );
    const outcome = await runEmbedHandshake({
      win: fakeWin(
        "/embed",
        "?platform=discord&code=oauth2-code&state=signed-state",
      ),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      client,
    });
    expect(outcome.status).toBe("authenticated");
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toMatchObject({
      platform: "discord",
      signedLaunchPayload: "oauth2-code",
      state: "signed-state",
    });
  });

  it("auto-detects telegram from injected initData on a bare /embed URL", async () => {
    // The Telegram web_app button links to a bare `<base>/embed` (no ?platform).
    const { client, setToken } = fakeClient();
    const fetchImpl = fakeFetch(
      jsonResponse(200, { role: "OWNER", adminMode: true, token: "tok" }),
    );
    const outcome = await runEmbedHandshake({
      win: fakeWin("/embed", "", "tg-init"),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      client,
    });
    expect(outcome.status).toBe("authenticated");
    expect(setToken).toHaveBeenCalledWith("tok");
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toMatchObject({
      platform: "telegram",
      signedLaunchPayload: "tg-init",
    });
  });

  it("auto-detects discord from a bare /embed?code= redirect", async () => {
    const { client } = fakeClient();
    const fetchImpl = fakeFetch(
      jsonResponse(200, { role: "ADMIN", adminMode: true, token: "t" }),
    );
    const outcome = await runEmbedHandshake({
      win: fakeWin("/embed", "?code=disc-code&state=signed-state"),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      client,
    });
    expect(outcome.status).toBe("authenticated");
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toMatchObject({
      platform: "discord",
      signedLaunchPayload: "disc-code",
      state: "signed-state",
    });
  });

  it("fails closed when a discord redirect has a code but omits OAuth state", async () => {
    const { client, setToken } = fakeClient();
    const fetchImpl = fakeFetch(
      jsonResponse(200, { role: "ADMIN", adminMode: true, token: "t" }),
    );
    const outcome = await runEmbedHandshake({
      win: fakeWin("/embed", "?code=disc-code"),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      client,
    });
    expect(outcome).toEqual({
      status: "failed",
      reason: "missing_oauth_state",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(setToken).not.toHaveBeenCalled();
  });

  it("fails closed on a bare /embed with no platform signal at all", async () => {
    const { client } = fakeClient();
    const outcome = await runEmbedHandshake({
      win: fakeWin("/embed"),
      client,
    });
    expect(outcome).toEqual({ status: "failed", reason: "unknown_platform" });
  });

  it("fails closed on a 403 without installing a token", async () => {
    const { client, setToken } = fakeClient();
    const fetchImpl = fakeFetch(jsonResponse(403, { error: "nope" }));
    const outcome = await runEmbedHandshake({
      win: fakeWin("/embed", "?platform=telegram", "tg"),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      client,
    });
    expect(outcome).toEqual({ status: "failed", reason: "http_403" });
    expect(setToken).not.toHaveBeenCalled();
  });

  it("fails closed when the response carries no token", async () => {
    const { client, setToken } = fakeClient();
    const fetchImpl = fakeFetch(jsonResponse(200, { role: "OWNER" }));
    const outcome = await runEmbedHandshake({
      win: fakeWin("/embed", "?platform=telegram", "tg"),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      client,
    });
    expect(outcome).toEqual({ status: "failed", reason: "no_token" });
    expect(setToken).not.toHaveBeenCalled();
  });

  it("fails closed when the fetch rejects", async () => {
    const { client, setToken } = fakeClient();
    const fetchImpl = fakeFetch(new Error("network down"));
    const outcome = await runEmbedHandshake({
      win: fakeWin("/embed", "?platform=telegram", "tg"),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      client,
    });
    expect(outcome).toEqual({ status: "failed", reason: "network_error" });
    expect(setToken).not.toHaveBeenCalled();
  });

  it("fails closed when the auth request times out", async () => {
    vi.useFakeTimers();
    try {
      const { client, setToken } = fakeClient();
      const fetchImpl = vi.fn(
        (_url: string, _init?: RequestInit) => new Promise<Response>(() => {}),
      );
      const outcomePromise = runEmbedHandshake({
        win: fakeWin("/embed", "?platform=telegram", "tg"),
        fetchImpl: fetchImpl as unknown as typeof fetch,
        client,
        timeoutMs: 25,
      });

      await vi.advanceTimersByTimeAsync(25);

      await expect(outcomePromise).resolves.toEqual({
        status: "failed",
        reason: "network_timeout",
      });
      expect(setToken).not.toHaveBeenCalled();
      expect(fetchImpl.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
    } finally {
      vi.useRealTimers();
    }
  });
});
