/** Deterministic HTTP boundary fixtures for Apps drawer stories and component tests. */
import {
  type AccessConnection,
  createAccessClient,
  type RemoteCredentialRequest,
} from "access/client";

export const fixtureRequest: RemoteCredentialRequest = {
  id: "request-fixture",
  site: "example.com",
  refs: ["vault://example.com/password"],
  openedAt: 0,
  expiresAt: 4102444800000,
  spec: {
    root: "root",
    elements: {
      root: {
        type: "CredentialRequest",
        props: { site: "example.com", title: "Sign in" },
        children: ["password", "submit"],
      },
      password: {
        type: "SecretField",
        props: {
          ref: "vault://example.com/password",
          kind: "password",
          label: "Password",
        },
        children: [],
      },
      submit: {
        type: "Submit",
        props: { label: "Save to vault" },
        children: [],
      },
    },
  },
};
export const fixtureConnection: AccessConnection = {
  account: {
    id: "example",
    site: "example.com",
    label: "Work account",
    active: true,
  },
  status: "not_connected",
  verifiedAt: null,
  error: null,
  pending: null,
  handoff: null,
  operations: [],
  approvals: [],
};

/** HTTP simulation keeps the public SDK transport and validation active in UI tests. */
export function createDrawerFixture(
  initial: AccessConnection | null = fixtureConnection,
) {
  let connection = initial === null ? null : structuredClone(initial);
  const calls: { method: string; path: string; body: string | null }[] = [];
  const client = createAccessClient({
    baseUrl: "https://access.example.test",
    token: () => "fixture-token",
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? init.body : null;
      calls.push({ method, path: url.pathname, body });
      const json = (value: object, status = 200) =>
        Response.json(value, { status });
      if (url.pathname === "/accounts" && method === "GET")
        return json({
          accounts: connection === null ? [] : [connection.account],
        });
      if (url.pathname === "/accounts" && method === "POST" && body !== null) {
        const account = JSON.parse(body) as {
          id: string;
          site: string;
          label: string;
        };
        connection = {
          ...structuredClone(fixtureConnection),
          account: {
            ...account,
            site: new URL(account.site).host,
            active: true,
          },
        };
        return json({ account: connection.account });
      }
      if (connection === null) return json({ error: "missing" }, 404);
      if (url.pathname.endsWith("/connection")) return json(connection);
      if (method === "DELETE") {
        connection = null;
        return json({ revoked: true });
      }
      if (method === "PATCH" && body !== null) {
        const data = JSON.parse(body) as { label: string };
        connection.account.label = data.label;
        return json({ account: connection.account });
      }
      if (url.pathname.endsWith("/credentials/pending") && method === "POST") {
        connection.pending = null;
        return json({ refs: fixtureRequest.refs });
      }
      if (url.pathname.includes("/approvals/") && body !== null) {
        const approval = connection.approvals.find((item) =>
          url.pathname.endsWith(item.id),
        );
        if (!approval) return json({ error: "missing" }, 404);
        const data = JSON.parse(body) as {
          decision: "approved" | "denied";
          effectDigest: string;
        };
        if (data.effectDigest !== approval.effectDigest)
          return json({ error: "conflict" }, 409);
        approval.status = data.decision;
        return json(approval);
      }
      if (url.pathname.endsWith("/operations") && body !== null) {
        const data = JSON.parse(body) as {
          id: string;
          kind: "connect" | "resume";
        };
        const operation = {
          id: data.id,
          accountId: connection.account.id,
          kind: data.kind,
          status:
            data.kind === "connect"
              ? ("waiting_credentials" as const)
              : ("completed" as const),
          thread: "fixture-thread",
          createdAt: 0,
          updatedAt: 0,
          output: null,
          error: null,
        };
        if (data.kind === "connect") {
          connection.pending = structuredClone(fixtureRequest);
          connection.status = "credentials_required";
        } else {
          connection.status = "connected";
          connection.verifiedAt = 0;
          connection.operations = connection.operations.map((item) => ({
            ...item,
            status: "completed",
          }));
        }
        connection.operations.push(operation);
        return json(operation);
      }
      return json({ error: "unsupported fixture route" }, 404);
    },
  });
  return { client, calls };
}
