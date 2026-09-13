/** Exercises the mounted private-browser UI and real SDK against deterministic HTTP receipts and failures. */
// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createBrowserFixture,
  fixtureFrame,
  fixtureHandoff,
} from "./browser-fixtures";
import { BrowserHandoff } from "./browser-handoff";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const onResumed = async () => undefined;
async function openScreen() {
  fireEvent.click(screen.getByRole("button", { name: "Open private browser" }));
  const image = await screen.findByAltText("Private website screen");
  fireEvent.load(image);
  return image;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("Account browser handoff", () => {
  it("waits for visible image pixels and sends typed, versioned controls without invented keyboard clicks", async () => {
    const fixture = createBrowserFixture();
    render(
      <BrowserHandoff
        client={fixture.client}
        accountId="example"
        handoff={fixtureHandoff}
        onResumed={onResumed}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Open private browser" }),
    );
    const image = await screen.findByAltText("Private website screen");
    const enter = screen.getByRole("button", { name: "Enter" });
    expect(enter.hasAttribute("disabled")).toBe(true);
    fireEvent.click(enter);
    expect(fixture.calls).toHaveLength(1);
    fireEvent.load(image);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Interact with private browser screen",
      }),
    );
    expect(fixture.calls).toHaveLength(1);
    fireEvent.click(enter);
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain(
        "Loading private screen",
      ),
    );
    fireEvent.load(screen.getByAltText("Private website screen"));
    fireEvent.click(screen.getByRole("button", { name: "Scroll down" }));
    await waitFor(() => expect(fixture.calls).toHaveLength(3));
    const bodies = fixture.calls
      .filter((call) => call.body)
      .map((call) => JSON.parse(call.body ?? "null"));
    expect(
      bodies.map((body) => ({ version: body.version, action: body.action })),
    ).toEqual([
      { version: 1, action: { kind: "press", key: "Enter" } },
      { version: 2, action: { kind: "scroll", dx: 0, dy: 500 } },
    ]);
    expect(bodies[0].id).not.toBe(bodies[1].id);
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("reloads the image even when an explicit refresh returns the same frame version", async () => {
    const fixture = createBrowserFixture();
    render(
      <BrowserHandoff
        client={fixture.client}
        accountId="example"
        handoff={fixtureHandoff}
        onResumed={onResumed}
      />,
    );
    const first = await openScreen();
    fireEvent.click(screen.getByRole("button", { name: "Refresh screen" }));
    await waitFor(() => expect(first.isConnected).toBe(false));
    expect(first.hasAttribute("src")).toBe(false);
    const next = screen.getByAltText("Private website screen");
    fireEvent.load(next);
    expect(
      screen.getByRole("button", { name: "Enter" }).hasAttribute("disabled"),
    ).toBe(false);
  });

  it("maps pointer coordinates to the image rather than the surrounding control", async () => {
    const fixture = createBrowserFixture();
    render(
      <BrowserHandoff
        client={fixture.client}
        accountId="example"
        handoff={fixtureHandoff}
        onResumed={onResumed}
      />,
    );
    const image = await openScreen();
    image.getBoundingClientRect = () => ({
      x: 20,
      y: 30,
      left: 20,
      top: 30,
      right: 420,
      bottom: 330,
      width: 400,
      height: 300,
      toJSON: () => ({}),
    });
    const screenButton = screen.getByRole("button", {
      name: "Interact with private browser screen",
    });
    fireEvent.click(screenButton, { detail: 1, clientX: 10, clientY: 50 });
    expect(fixture.calls).toHaveLength(1);
    fireEvent.click(screenButton, { detail: 1, clientX: 120, clientY: 180 });
    await waitFor(() => expect(fixture.calls).toHaveLength(2));
    expect(JSON.parse(fixture.calls[1]?.body ?? "null").action).toEqual({
      kind: "click",
      x: 200,
      y: 300,
    });
  });

  it("hides uncertain mutations, prevents concurrent/replayed actions, and requires a new frame", async () => {
    const pending = deferred<Response>();
    const fixture = createBrowserFixture(async (call) =>
      call.path.endsWith("/actions") ? pending.promise : null,
    );
    render(
      <BrowserHandoff
        client={fixture.client}
        accountId="example"
        handoff={fixtureHandoff}
        onResumed={onResumed}
      />,
    );
    await openScreen();
    const enter = screen.getByRole("button", { name: "Enter" });
    fireEvent.click(enter);
    fireEvent.click(enter);
    await waitFor(() => expect(fixture.calls).toHaveLength(2));
    await act(async () =>
      pending.resolve(
        Response.json({ error: "private-diagnostic" }, { status: 409 }),
      ),
    );
    expect(screen.queryByAltText("Private website screen")).toBeNull();
    expect(screen.queryByRole("button", { name: "Enter" })).toBeNull();
    expect(document.body.textContent).not.toContain("private-diagnostic");
    fireEvent.click(screen.getByRole("button", { name: "Refresh screen" }));
    fireEvent.load(await screen.findByAltText("Private website screen"));
    expect(fixture.calls.filter((call) => call.method === "POST")).toHaveLength(
      1,
    );
    expect(
      screen.getByRole("button", { name: "Enter" }).hasAttribute("disabled"),
    ).toBe(false);
  });

  it("clears an acknowledged resume even if connection refresh fails and never repeats it", async () => {
    const fixture = createBrowserFixture();
    render(
      <BrowserHandoff
        client={fixture.client}
        accountId="example"
        handoff={fixtureHandoff}
        onResumed={async () => {
          throw new Error("refresh failed");
        }}
      />,
    );
    await openScreen();
    fireEvent.click(
      screen.getByRole("button", { name: "Finished verification" }),
    );
    await screen.findByText(
      "Verification sent. Aiko is continuing the connection.",
    );
    expect(screen.queryByAltText("Private website screen")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Finished verification" }),
    ).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain(
      "Refresh the app connection",
    );
    expect(
      fixture.calls.filter((call) => call.path.endsWith("/resume")),
    ).toHaveLength(1);
  });

  it("refuses a well-shaped resume receipt for another account", async () => {
    let refreshes = 0;
    const fixture = createBrowserFixture(async (call) => {
      if (!call.path.endsWith("/resume")) return null;
      const command = JSON.parse(call.body ?? "null");
      return Response.json({
        id: command.id,
        accountId: "other",
        kind: "resume",
        status: "pending",
        thread: "fixture-thread",
        createdAt: 0,
        updatedAt: 0,
        output: null,
        error: null,
      });
    });
    render(
      <BrowserHandoff
        client={fixture.client}
        accountId="example"
        handoff={fixtureHandoff}
        onResumed={async () => {
          refreshes += 1;
        }}
      />,
    );
    await openScreen();
    fireEvent.click(
      screen.getByRole("button", { name: "Finished verification" }),
    );
    await screen.findByRole("alert");
    expect(refreshes).toBe(0);
    expect(screen.queryByAltText("Private website screen")).toBeNull();
  });

  it.each(["account", "client", "handoff", "unmount"] as const)(
    "discards a pending private frame after %s changes and aborts its read",
    async (change) => {
      const pending = deferred<Response>();
      const fixture = createBrowserFixture(async () => pending.promise);
      const props = {
        client: fixture.client,
        accountId: "example",
        handoff: fixtureHandoff,
        onResumed,
      };
      const view = render(<BrowserHandoff {...props} />);
      fireEvent.click(
        screen.getByRole("button", { name: "Open private browser" }),
      );
      await waitFor(() => expect(fixture.calls).toHaveLength(1));
      if (change === "unmount") view.unmount();
      else
        view.rerender(
          <BrowserHandoff
            {...props}
            {...(change === "account"
              ? { accountId: "other" }
              : change === "client"
                ? { client: createBrowserFixture().client }
                : {
                    handoff: {
                      ...fixtureHandoff,
                      id: "e84f4df1-9b0e-4e86-801a-a7e2d997067c",
                    },
                  })}
          />,
        );
      expect(fixture.calls[0]?.signal?.aborted).toBe(true);
      await act(async () => pending.resolve(Response.json(fixtureFrame)));
      expect(screen.queryByAltText("Private website screen")).toBeNull();
    },
  );

  it("discards a late mutation response and private image on account change", async () => {
    const pending = deferred<Response>();
    const fixture = createBrowserFixture(async (call) =>
      call.path.endsWith("/actions") ? pending.promise : null,
    );
    const view = render(
      <BrowserHandoff
        client={fixture.client}
        accountId="example"
        handoff={fixtureHandoff}
        onResumed={onResumed}
      />,
    );
    const image = await openScreen();
    fireEvent.click(screen.getByRole("button", { name: "Enter" }));
    view.rerender(
      <BrowserHandoff
        client={fixture.client}
        accountId="other"
        handoff={fixtureHandoff}
        onResumed={onResumed}
      />,
    );
    await act(async () =>
      pending.resolve(Response.json({ ...fixtureFrame, version: 2 })),
    );
    expect(screen.queryByAltText("Private website screen")).toBeNull();
    expect(image.isConnected).toBe(false);
    expect(image.hasAttribute("src")).toBe(false);
  });

  it("expires a frame before its handoff and clears all controls when the handoff expires", async () => {
    const now = Date.now();
    const fixture = createBrowserFixture(async () =>
      Response.json({ ...fixtureFrame, expiresAt: now + 1000 }),
    );
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    render(
      <BrowserHandoff
        client={fixture.client}
        accountId="example"
        handoff={{ ...fixtureHandoff, expiresAt: now + 2000 }}
        onResumed={onResumed}
      />,
    );
    await act(async () =>
      fireEvent.click(
        screen.getByRole("button", { name: "Open private browser" }),
      ),
    );
    fireEvent.load(screen.getByAltText("Private website screen"));
    act(() => vi.advanceTimersByTime(1001));
    expect(screen.queryByAltText("Private website screen")).toBeNull();
    expect(screen.getByRole("button", { name: "Refresh screen" })).toBeTruthy();
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.queryByRole("button")).toBeNull();
    expect(document.body.textContent).toContain("Reconnect the app");
  });

  it("refuses image decode failure and does not expose capabilities the handoff lacks", async () => {
    const fixture = createBrowserFixture();
    render(
      <BrowserHandoff
        client={fixture.client}
        accountId="example"
        handoff={{ ...fixtureHandoff, capabilities: ["press"] }}
        onResumed={onResumed}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Open private browser" }),
    );
    const image = await screen.findByAltText("Private website screen");
    expect(screen.queryByRole("button", { name: "Scroll down" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Finished verification" }),
    ).toBeNull();
    fireEvent.error(image);
    expect(screen.queryByAltText("Private website screen")).toBeNull();
    expect(image.hasAttribute("src")).toBe(false);
    expect(screen.getByRole("alert").textContent).toContain(
      "could not be displayed",
    );
  });

  it("never calls the old account refresh for a late resume receipt", async () => {
    const pending = deferred<Response>();
    const fixture = createBrowserFixture(async (call) =>
      call.path.endsWith("/resume") ? pending.promise : null,
    );
    let refreshes = 0;
    const view = render(
      <BrowserHandoff
        client={fixture.client}
        accountId="example"
        handoff={fixtureHandoff}
        onResumed={async () => {
          refreshes += 1;
        }}
      />,
    );
    await openScreen();
    fireEvent.click(
      screen.getByRole("button", { name: "Finished verification" }),
    );
    await waitFor(() => expect(fixture.calls).toHaveLength(2));
    view.unmount();
    const command = JSON.parse(fixture.calls[1]?.body ?? "null");
    await act(async () =>
      pending.resolve(
        Response.json({
          id: command.id,
          accountId: "example",
          kind: "resume",
          status: "pending",
          thread: "fixture-thread",
          createdAt: 0,
          updatedAt: 0,
          output: null,
          error: null,
        }),
      ),
    );
    expect(refreshes).toBe(0);
  });

  it.each(["foreign", "url", "image", "expired"] as const)(
    "refuses a %s frame before private interaction",
    async (invalid) => {
      const frame = { ...fixtureFrame };
      if (invalid === "foreign")
        frame.handoffId = "e84f4df1-9b0e-4e86-801a-a7e2d997067c";
      if (invalid === "url") frame.url = "https://example.com/?token=secret";
      if (invalid === "image")
        frame.image = { mimeType: "image/png", base64: "<svg>" };
      if (invalid === "expired") frame.expiresAt = 0;
      const fixture = createBrowserFixture(async () => Response.json(frame));
      render(
        <BrowserHandoff
          client={fixture.client}
          accountId="example"
          handoff={fixtureHandoff}
          onResumed={onResumed}
        />,
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Open private browser" }),
      );
      await screen.findByRole("alert");
      expect(screen.queryByAltText("Private website screen")).toBeNull();
      expect(fixture.calls).toHaveLength(1);
    },
  );
});
