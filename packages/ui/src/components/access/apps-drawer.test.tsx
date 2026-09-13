/** Tests real drawer interactions and SDK validation against a deterministic HTTP boundary. */

// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createAccessClient } from "access/client";
import { afterEach, describe, expect, it } from "vitest";
import { isSensitiveAgentElement } from "../../agent-surface/sensitive";
import { AppsDrawer, websiteOrigin } from "./apps-drawer";
import { CredentialForm, credentialFields } from "./credential-form";
import {
  createDrawerFixture,
  fixtureConnection,
  fixtureRequest,
} from "./fixtures";

afterEach(cleanup);

describe("Access Apps drawer", () => {
  it("keeps an account usable when its website favicon cannot load", async () => {
    render(
      <AppsDrawer client={createDrawerFixture(fixtureConnection).client} />,
    );
    const account = await screen.findByRole("button", {
      name: /Work account/,
    });
    const icon = account.querySelector("img");
    expect(icon?.getAttribute("src")).toBe("https://example.com/favicon.ico");
    if (!icon) throw new Error("Website icon missing");
    fireEvent.error(icon);
    expect(account.querySelector("img")).toBeNull();
    expect(account.textContent).toContain("↗");
    fireEvent.click(account);
    await screen.findByRole("button", { name: "Connect account" });
  });

  it("recovers after credentials were saved but the resume exchange was interrupted", async () => {
    const connection = structuredClone(fixtureConnection);
    connection.status = "credentials_required";
    connection.operations = [
      {
        id: "00000000-0000-4000-8000-000000000001",
        accountId: "example",
        kind: "connect",
        status: "waiting_credentials",
        thread: "interrupted-thread",
        createdAt: 0,
        updatedAt: 0,
        output: null,
        error: null,
      },
    ];
    const fixture = createDrawerFixture(connection);
    render(<AppsDrawer client={fixture.client} />);
    fireEvent.click(
      await screen.findByRole("button", { name: /Work account/ }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Continue task" }),
    );
    await screen.findByText("Connected");
    expect(
      fixture.calls.some((call) => call.path.endsWith("/credentials/pending")),
    ).toBe(false);
    const resume = fixture.calls.find((call) =>
      call.path.endsWith("/operations"),
    );
    expect(JSON.parse(resume?.body ?? "null").operationId).toBe(
      connection.operations[0]?.id,
    );
  });

  it("adds an app, requests the reviewed form, and resumes the waiting native operation after vault submission", async () => {
    const fixture = createDrawerFixture(null);
    render(<AppsDrawer client={fixture.client} />);
    fireEvent.click(await screen.findByRole("button", { name: /Add an app/ }));
    fireEvent.change(screen.getByLabelText("Website"), {
      target: { value: "example.com" },
    });
    fireEvent.change(screen.getByLabelText("Account name (optional)"), {
      target: { value: "Work account" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add app" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Connect account" }),
    );
    const input = await screen.findByLabelText("Password");
    fireEvent.change(input, { target: { value: "isolated-secret-value" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    await screen.findByText("Connected");
    const submit = fixture.calls.find(
      (call) =>
        call.method === "POST" && call.path.endsWith("/credentials/pending"),
    );
    expect(JSON.parse(submit?.body ?? "null")).toEqual({
      id: fixtureRequest.id,
      values: { "vault://example.com/password": "isolated-secret-value" },
    });
    const commands = fixture.calls
      .filter((call) => call.path.endsWith("/operations"))
      .map(
        (call) =>
          JSON.parse(call.body ?? "null") as {
            kind: string;
            id: string;
            operationId?: string;
          },
      );
    expect(commands.map((command) => command.kind)).toEqual([
      "connect",
      "resume",
    ]);
    expect(commands[1]?.operationId).toBe(commands[0]?.id);
    expect(document.body.textContent).not.toContain("isolated-secret-value");
    expect(screen.queryByLabelText("Password")).toBeNull();
    expect(
      fixture.calls.filter((call) =>
        call.body?.includes("isolated-secret-value"),
      ),
    ).toHaveLength(1);
  });

  it("sends only the displayed approval digest and requires confirmation before revocation", async () => {
    const connection = structuredClone(fixtureConnection);
    connection.status = "connected";
    connection.approvals = [
      {
        id: "approval-1",
        accountId: "example",
        operationId: "00000000-0000-4000-8000-000000000001",
        description: "Send the prepared invoice",
        effectDigest: "bound-effect-digest",
        status: "pending",
        createdAt: 0,
        expiresAt: 4102444800000,
      },
    ];
    const fixture = createDrawerFixture(connection);
    render(<AppsDrawer client={fixture.client} />);
    fireEvent.click(
      await screen.findByRole("button", { name: /Work account/ }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Allow this action" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Allow this action" }),
      ).toBeNull(),
    );
    const approval = fixture.calls.find((call) =>
      call.path.endsWith("/approvals/approval-1"),
    );
    expect(JSON.parse(approval?.body ?? "null")).toEqual({
      decision: "approved",
      effectDigest: "bound-effect-digest",
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Remove this connection" }),
    );
    expect(fixture.calls.some((call) => call.method === "DELETE")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Remove access" }));
    await waitFor(() =>
      expect(
        fixture.calls.filter((call) => call.method === "DELETE"),
      ).toHaveLength(1),
    );
  });

  it("shows unavailable account data separately from a designed empty drawer", async () => {
    const client = createAccessClient({
      baseUrl: "https://access.example.test",
      token: () => "fixture-token",
      fetch: async () =>
        Response.json({ error: "secret-bearing-diagnostic" }, { status: 503 }),
    });
    render(<AppsDrawer client={client} />);
    await screen.findByText("Your apps could not be loaded");
    expect(screen.queryByText("A place for the apps in your day")).toBeNull();
    expect(document.body.textContent).not.toContain(
      "secret-bearing-diagnostic",
    );
  });

  it("refuses credential-bearing website metadata and expired browser handoffs", async () => {
    expect(websiteOrigin("https://user:password@example.com")).toBeNull();
    expect(websiteOrigin("https://example.com?token=secret")).toBeNull();
    expect(websiteOrigin("javascript:alert(1)")).toBeNull();
    expect(websiteOrigin("example.com")).toBe("https://example.com");
    const connection = structuredClone(fixtureConnection);
    connection.handoff = {
      id: "f8dbca12-dc8e-41e5-83c1-c7136e2ef356",
      operationId: "174b4dda-e3ab-4b11-8266-5b17499a3184",
      expiresAt: 0,
      reason: "Finish website verification",
      status: "expired",
      capabilities: ["click", "scroll", "press", "resume"],
      unsupported: ["passkeys"],
    };
    render(<AppsDrawer client={createDrawerFixture(connection).client} />);
    fireEvent.click(
      await screen.findByRole("button", { name: /Work account/ }),
    );
    await screen.findByText(
      "This browser session is unavailable or expired. Reconnect the app to continue.",
    );
    expect(
      screen.queryByRole("button", { name: "Open private browser" }),
    ).toBeNull();
  });
});

describe("Access credential isolation", () => {
  it("rejects a foreign vault site even when both reference lists agree", () => {
    const request = structuredClone(fixtureRequest);
    request.refs = ["vault://other.example/password"];
    request.spec.elements.password = {
      type: "SecretField",
      props: { ref: request.refs[0], kind: "password" },
      children: [],
    };
    expect(credentialFields(request)).toBeNull();
    request.site = "other.example";
    request.spec.elements.root = {
      type: "CredentialRequest",
      props: { site: request.site, title: "Sign in" },
      children: ["password", "submit"],
    };
    render(
      <CredentialForm
        accountSite={fixtureConnection.account.site}
        request={request}
        onCancel={() => undefined}
        onSubmit={async () => undefined}
      />,
    );
    expect(screen.queryByLabelText("Password")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain(
      "could not be verified",
    );
  });

  it("marks every generated field private to the existing agent surface, including ordinary-looking usernames", () => {
    const request = structuredClone(fixtureRequest);
    request.spec.elements.password = {
      type: "SecretField",
      props: {
        ref: fixtureRequest.refs[0],
        kind: "username",
        label: "Username",
      },
      children: [],
    };
    render(
      <CredentialForm
        accountSite={fixtureConnection.account.site}
        request={request}
        onCancel={() => undefined}
        onSubmit={async () => undefined}
      />,
    );
    const field = screen.getByLabelText("Username");
    expect(
      isSensitiveAgentElement({ id: "login-name", label: "Username" }, field),
    ).toBe(true);
  });

  it("rejects disconnected elements, duplicate refs, and refs outside the request", () => {
    const foreign = structuredClone(fixtureRequest);
    foreign.refs = ["vault://other.example/password"];
    expect(credentialFields(foreign)).toBeNull();
    const duplicate = structuredClone(fixtureRequest);
    duplicate.spec.elements.root.children = ["password", "password", "submit"];
    expect(credentialFields(duplicate)).toBeNull();
    const disconnected = structuredClone(fixtureRequest);
    disconnected.spec.elements.hidden = {
      type: "SecretField",
      props: { ref: "vault://other.example/password", kind: "password" },
      children: [],
    };
    expect(credentialFields(disconnected)).toBeNull();
    expect(credentialFields(fixtureRequest)).toHaveLength(1);
  });

  it("clears values immediately, prevents concurrent submissions, and never echoes a failed transport", async () => {
    let rejectSubmission: (reason: Error) => void = () => {
      throw new Error("Submission has not started");
    };
    let submissions = 0;
    render(
      <CredentialForm
        accountSite={fixtureConnection.account.site}
        request={fixtureRequest}
        onCancel={() => undefined}
        onSubmit={async () => {
          submissions += 1;
          await new Promise<void>((_resolve, reject) => {
            rejectSubmission = reject;
          });
        }}
      />,
    );
    const input = screen.getByLabelText("Password") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "private-value" } });
    const form = input.closest("form");
    if (!form) throw new Error("Credential form is not mounted");
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(submissions).toBe(1);
    expect(input.value).toBe("");
    rejectSubmission(new Error("private-value"));
    await screen.findByRole("alert");
    expect(document.body.textContent).not.toContain("private-value");
    expect(localStorage.length).toBe(0);
  });

  it("rejects expired requests and erases cancelled input", () => {
    let submissions = 0;
    const expired = { ...fixtureRequest, expiresAt: 1 };
    const view = render(
      <CredentialForm
        accountSite={fixtureConnection.account.site}
        request={expired}
        onCancel={() => undefined}
        onSubmit={async () => {
          submissions += 1;
        }}
      />,
    );
    expect(
      (screen.getByLabelText("Password") as HTMLInputElement).disabled,
    ).toBe(true);
    expect(submissions).toBe(0);
    view.rerender(
      <CredentialForm
        accountSite={fixtureConnection.account.site}
        request={fixtureRequest}
        onCancel={() => undefined}
        onSubmit={async () => {
          submissions += 1;
        }}
      />,
    );
    const input = screen.getByLabelText("Password") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "private-value" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(input.value).toBe("");
  });
});
