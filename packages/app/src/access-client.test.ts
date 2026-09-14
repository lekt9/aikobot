/** Exercises the real SDK transport adapter against authenticated response, authority swap and secret-safe failure boundaries. */
import { describe, expect, it } from "vitest";
import { ElizaClient } from "../../ui/src/api/client-base";
import {
  type AccessAppTransport,
  createAccessAppClient,
} from "./access-client";

describe("Access application transport", () => {
  it("retains the existing authenticated transport and returns full SDK data", async () => {
    const calls: { path: string; init: RequestInit | undefined }[] = [];
    const transport: AccessAppTransport = {
      getBaseUrl: () => "https://aiko.example",
      getRestAuthToken: () => "app-session",
      getAuthorityRevision: () => 1,
      rawRequest: async (path, init) => {
        calls.push({ path, init });
        return Response.json({
          accounts: [
            { id: "work", site: "example.com", label: "Work", active: true },
          ],
        });
      },
    };
    const sdk = createAccessAppClient(transport, "https://aiko.example");
    expect((await sdk.accounts.list()).accounts[0]?.label).toBe("Work");
    expect(calls[0]?.path).toBe("/access/accounts");
    expect(new Headers(calls[0]?.init?.headers).has("authorization")).toBe(
      false,
    );
    expect(calls[0]?.init?.redirect).toBe("error");
  });

  it("sends exactly one bearer through the real app client transport", async () => {
    const client = new ElizaClient(
      "https://aiko.example",
      "synthetic-owner-token",
    );
    const headers: Headers[] = [];
    client.setRequestTransport({
      request: async (_url, init) => {
        headers.push(new Headers(init?.headers));
        return Response.json({ accounts: [] });
      },
    });
    const sdk = createAccessAppClient(client, "https://aiko.example");
    expect(await sdk.accounts.list()).toEqual({ accounts: [] });
    expect(headers).toHaveLength(1);
    expect(headers[0].get("authorization")).toBe(
      "Bearer synthetic-owner-token",
    );
  });

  it("does not retry a sensitive operation after an authority switch", async () => {
    const client = new ElizaClient(
      "https://aiko.example",
      "synthetic-owner-token",
    );
    let dispatches = 0;
    client.setRequestTransport({
      request: async () => {
        dispatches++;
        client.setToken("synthetic-other-owner");
        return Response.json(
          { code: "feature_starting", retryable: true },
          { status: 503 },
        );
      },
    });
    const sdk = createAccessAppClient(client, "https://aiko.example");
    await expect(
      sdk.accounts.credentials.fulfill(
        "work",
        "00000000-0000-4000-8000-000000000001",
        { password: "fixture-private-password" },
      ),
    ).rejects.toThrow();
    expect(dispatches).toBe(1);
  });

  it("rechecks authority after asynchronous transport selection before sending bytes", async () => {
    const client = new ElizaClient(
      "https://aiko.example",
      "synthetic-owner-token",
    );
    let dispatches = 0;
    client.setRequestTransport({
      request: async () => {
        dispatches++;
        return Response.json({ accounts: [] });
      },
    });
    const request = client.rawRequest("/access/accounts", undefined, {
      boundAuthorityRevision: client.getAuthorityRevision(),
      allowNonOk: true,
    });
    client.setToken("synthetic-other-owner");
    await expect(request).rejects.toThrow();
    expect(dispatches).toBe(0);
  });

  it("rejects old-owner work before dispatch and responses arriving after an owner switch", async () => {
    let revision = 1;
    let requests = 0;
    let release!: (response: Response) => void;
    const transport: AccessAppTransport = {
      getBaseUrl: () => "https://aiko.example",
      getRestAuthToken: () => "app-session",
      getAuthorityRevision: () => revision,
      rawRequest: () => {
        requests += 1;
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    };
    const sdk = createAccessAppClient(transport, "https://aiko.example");
    const pending = sdk.accounts.list();
    await new Promise((resolve) => setTimeout(resolve, 0));
    revision += 1;
    release(Response.json({ accounts: [] }));
    await expect(pending).rejects.toThrow();
    await expect(sdk.accounts.list()).rejects.toThrow();
    expect(requests).toBe(1);
  });

  it("never dispatches without the authenticated app bearer", async () => {
    let requests = 0;
    const sdk = createAccessAppClient(
      {
        getBaseUrl: () => "",
        getRestAuthToken: () => null,
        getAuthorityRevision: () => 0,
        rawRequest: async () => {
          requests += 1;
          return Response.json({ accounts: [] });
        },
      },
      "https://aiko.example",
    );
    await expect(sdk.accounts.list()).rejects.toMatchObject({
      code: "unauthorized",
    });
    expect(requests).toBe(0);
  });
});
