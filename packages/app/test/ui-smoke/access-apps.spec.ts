/** Exercises the actual Telegram Apps renderer with fictional launch, account, and browser HTTP fixtures.
 * Captures contain no real credentials or account data. The component, SDK, loader, and app mount remain real.
 */
import { expect, type Page, test } from "@playwright/test";
import {
  type AccessApproval,
  type AccessConnection,
  type AccessOperation,
  operationInputSchema,
} from "access/client";
import {
  fixtureFrame,
  fixtureHandoff,
} from "../../../ui/src/components/access/browser-fixtures";
import {
  fixtureConnection,
  fixtureRequest,
} from "../../../ui/src/components/access/fixtures";
import { installDefaultAppRoutes, seedAppStorage } from "./helpers";
import { captureScreenshotWithQualityRetry } from "./helpers/screenshot-quality";

async function installAccess(page: Page) {
  await seedAppStorage(page);
  await installDefaultAppRoutes(page);
  // Playwright 1.62 treats every URL ending /favicon.ico as browser chrome and
  // aborts it before route fixtures. Rewrite only this fictional site's image
  // transport URL; the component still supplies its real canonical favicon URL.
  await page.addInitScript(() => {
    const descriptor = Object.getOwnPropertyDescriptor(
      HTMLImageElement.prototype,
      "src",
    );
    if (!descriptor?.set)
      throw new Error("Native image URL setter unavailable");
    const assign = descriptor.set;
    Object.defineProperty(HTMLImageElement.prototype, "src", {
      ...descriptor,
      set(value: string) {
        if (value === "https://example.com/favicon.ico") {
          this.setAttribute("data-fixture-original-src", value);
          assign.call(this, `${value}?ui-smoke`);
        } else assign.call(this, value);
      },
    });
  });
  await page.route("https://example.com/favicon.ico?ui-smoke", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#c65318"/><text x="32" y="46" text-anchor="middle" font-family="sans-serif" font-weight="700" font-size="42" fill="white">E</text></svg>',
    }),
  );
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 800;
    canvas.height = 600;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Fixture canvas unavailable");
    ctx.fillStyle = "#fffaf5";
    ctx.fillRect(0, 0, 800, 600);
    ctx.fillStyle = "#282018";
    ctx.font = "32px sans-serif";
    ctx.fillText("Example.com verification", 50, 95);
    ctx.font = "22px sans-serif";
    ctx.fillText("Fictional test website", 50, 150);
    ctx.strokeRect(50, 225, 40, 40);
    ctx.fillText("I am completing this verification", 110, 254);
    ctx.fillStyle = "#b94f18";
    ctx.fillRect(50, 335, 250, 60);
    ctx.fillStyle = "white";
    ctx.fillText("Continue", 85, 373);
    ctx.fillStyle = "#62594f";
    ctx.fillText("Fixture only. No private account data.", 50, 515);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  let connection = structuredClone(fixtureConnection);
  connection.status = "verification_required";
  connection.handoff = { ...fixtureHandoff, expiresAt: Date.now() + 600_000 };
  let frame = {
    ...fixtureFrame,
    image: { mimeType: "image/png" as const, base64: png },
    expiresAt: Date.now() + 600_000,
  };
  let failAction = false;
  const commands: { path: string; body: Record<string, unknown> }[] = [];
  await page.route("https://telegram.org/js/telegram-web-app.js**", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: 'window.Telegram={WebApp:{initData:"fixture-signed-launch",ready(){},expand(){}}};',
    }),
  );
  await page.route("**/api/embed/auth", (route) =>
    route.fulfill({
      json: { token: "fixture-owner-session", role: "OWNER", adminMode: false },
    }),
  );
  await page.route("**/access/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST")
      commands.push({ path, body: request.postDataJSON() });
    if (path.endsWith("/events"))
      return route.fulfill({
        json: { events: [], nextCursor: 0, hasMore: false },
      });
    if (path.endsWith("/accounts"))
      return route.fulfill({ json: { accounts: [connection.account] } });
    if (path.endsWith("/credentials/pending"))
      return route.fulfill({
        status: 503,
        json: { error: "fixture-private-diagnostic" },
      });
    if (path.endsWith("/connection"))
      return route.fulfill({ json: connection });
    if (path.endsWith("/frame")) return route.fulfill({ json: frame });
    if (path.endsWith("/actions")) {
      if (failAction) {
        failAction = false;
        return route.fulfill({ status: 409, json: { error: "uncertain" } });
      }
      const command = request.postDataJSON();
      expect(command.version).toBe(frame.version);
      frame = { ...frame, version: frame.version + 1 };
      return route.fulfill({ json: frame });
    }
    if (path.endsWith("/resume")) {
      const command = request.postDataJSON();
      expect(command.version).toBe(frame.version);
      connection = {
        ...connection,
        handoff: null,
        status: "connected",
        verifiedAt: Date.now(),
      };
      return route.fulfill({
        json: {
          id: command.id,
          accountId: connection.account.id,
          kind: "resume",
          status: "pending",
          thread: "fixture-thread",
          createdAt: 0,
          updatedAt: 0,
          output: null,
          error: null,
        },
      });
    }
    return route.fulfill({
      status: 404,
      json: { error: "unsupported fixture route" },
    });
  });
  return {
    png,
    commands,
    failNextAction: () => {
      failAction = true;
    },
    requireCredentials: () => {
      connection = {
        ...connection,
        status: "credentials_required",
        pending: fixtureRequest,
      };
    },
  };
}

for (const viewport of [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`Access Apps ${viewport.name}: private browser, recovery and completion`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    const fixture = await installAccess(page);
    await testInfo.attach("fictional-browser-frame", {
      body: Buffer.from(fixture.png, "base64"),
      contentType: "image/png",
    });
    await page.goto("/embed/apps?platform=telegram");
    const capture = async (name: string) => {
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      const path = testInfo.outputPath(`${name}.png`);
      await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
      });
      await captureScreenshotWithQualityRetry(page, name, {
        path,
        fullPage: false,
      });
      await testInfo.attach(name, { path, contentType: "image/png" });
    };
    await expect(
      page.getByRole("button", { name: /Work account/ }),
    ).toBeVisible();
    const favicon = page.locator(".access-app-icon img").first();
    await expect(favicon).toHaveAttribute(
      "data-fixture-original-src",
      "https://example.com/favicon.ico",
    );
    await expect
      .poll(() =>
        favicon.evaluate(
          (image) =>
            image instanceof HTMLImageElement &&
            image.complete &&
            image.naturalWidth > 0,
        ),
      )
      .toBe(true);
    const drawerBounds = await page.locator(".access-apps").boundingBox();
    expect(drawerBounds).not.toBeNull();
    if (viewport.name === "desktop")
      expect(drawerBounds?.width).toBeGreaterThan(viewport.width / 2);
    await capture("01-drawer-rest");
    await page.getByRole("button", { name: /Add an app/ }).hover();
    await capture("01-drawer-hover");
    await page.getByRole("button", { name: /Work account/ }).click();
    await expect(
      page.getByRole("button", { name: "Open private browser" }),
    ).toBeVisible();
    await capture("02-handoff-rest");
    await page.getByRole("button", { name: "Open private browser" }).click();
    await expect(
      page.getByRole("button", { name: "Enter", exact: true }),
    ).toBeEnabled();
    await page.getByAltText("Private website screen").scrollIntoViewIfNeeded();
    await capture("03-frame-rest");
    const finish = page.getByRole("button", { name: "Finished verification" });
    const restingFill = await finish.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    );
    await finish.hover();
    await expect
      .poll(() =>
        finish.evaluate((element) => getComputedStyle(element).backgroundColor),
      )
      .not.toBe(restingFill);
    await capture("03-frame-hover");
    await page.getByRole("button", { name: "Tab", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Enter", exact: true }),
    ).toBeEnabled();
    expect(fixture.commands.at(-1)?.body.action).toEqual({
      kind: "press",
      key: "Tab",
    });
    fixture.failNextAction();
    await page.getByRole("button", { name: "Enter", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText(
      "could not be confirmed",
    );
    await expect(page.getByAltText("Private website screen")).toHaveCount(0);
    await capture("04-uncertain-action");
    await page.getByRole("button", { name: "Refresh screen" }).click();
    await expect(finish).toBeEnabled();
    await finish.click();
    await expect(page.getByText("Connected", { exact: true })).toBeVisible();
    await expect(page.getByAltText("Private website screen")).toHaveCount(0);
    await capture("05-connected");
    fixture.requireCredentials();
    await page.getByRole("button", { name: "Refresh connection" }).click();
    const password = page.getByLabel("Password", { exact: true });
    await expect(password).toBeVisible();
    await capture("06-credential-sheet-empty");
    await password.fill("fictional-test-password");
    await page.getByRole("button", { name: "Save and continue" }).click();
    await expect(password).toHaveValue("");
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.locator("body")).not.toContainText(
      "fictional-test-password",
    );
    await expect(page.locator("body")).not.toContainText(
      "fixture-private-diagnostic",
    );
    await capture("07-credential-error-cleared");
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect(password).toHaveCount(0);
    expect(
      fixture.commands.filter((command) => command.path.endsWith("/resume")),
    ).toHaveLength(1);
  });
}

/** Fictional host state advances independently of command receipts, as the native projection does. */
async function installOnboarding(page: Page) {
  await installAccess(page);
  await page.unroute("**/access/**");
  let connection: AccessConnection | null = null;
  let credentialSubmitted = false;
  const { promise: credentialRelease, resolve: releaseCredentials } =
    Promise.withResolvers<void>();
  const requests: { method: string; path: string; status: number }[] = [];
  const posts: { path: string; containsCredential: boolean }[] = [];
  const decisions: {
    id: string;
    operationId: string;
    decision: string;
    effectDigest: string;
  }[] = [];
  const resumeTargets: string[] = [];
  const fictionalPassword = "fictional-onboarding-password";
  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    posts.push({
      path: new URL(request.url()).pathname,
      containsCredential:
        request.postData()?.includes(fictionalPassword) === true,
    });
  });
  const current = () => {
    if (connection === null)
      throw new Error("Fixture account has not been created");
    return connection;
  };
  await page.route("**/access/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const reply = (json: object, status = 200) => {
      requests.push({ method, path, status });
      return route.fulfill({ json, status });
    };
    if (path === "/access/events")
      return reply({ events: [], nextCursor: 0, hasMore: false });
    if (path === "/access/accounts") {
      if (method === "GET")
        return reply({
          accounts: connection === null ? [] : [connection.account],
        });
      const body = request.postDataJSON();
      expect(body).toEqual({
        id: expect.any(String),
        site: "https://example.com",
        label: "Personal account",
      });
      connection = {
        ...structuredClone(fixtureConnection),
        account: { ...body, site: "example.com", active: true },
      };
      return reply({ account: connection.account });
    }
    const value = current();
    const accountPath = `/access/accounts/${value.account.id}`;
    if (path === `${accountPath}/connection`) return reply(value);
    if (path === `${accountPath}/credentials/pending` && method === "POST") {
      expect(request.postDataJSON()).toEqual({
        id: fixtureRequest.id,
        values: { "vault://example.com/password": fictionalPassword },
      });
      credentialSubmitted = true;
      await credentialRelease;
      value.pending = null;
      return reply({ refs: fixtureRequest.refs });
    }
    if (path === `${accountPath}/operations` && method === "POST") {
      const command = operationInputSchema.parse(request.postDataJSON());
      expect(["connect", "resume"]).toContain(command.kind);
      const operation: AccessOperation = {
        id: command.id,
        accountId: value.account.id,
        kind: command.kind,
        status: command.kind === "connect" ? "waiting_credentials" : "running",
        thread: "fixture-onboarding-thread",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        output: null,
        error: null,
      };
      if (command.kind === "connect") {
        value.pending = structuredClone(fixtureRequest);
        value.status = "credentials_required";
      } else if (command.kind === "resume") {
        expect(credentialSubmitted).toBe(true);
        expect(value.pending).toBeNull();
        expect(
          value.operations.find((item) => item.id === command.operationId)
            ?.status,
        ).toBe("waiting_credentials");
        resumeTargets.push(command.operationId);
        value.status = "connecting";
        value.operations = value.operations.map((item) => ({
          ...item,
          status: "running",
        }));
      }
      value.operations.push(operation);
      return reply(operation);
    }
    const approval = value.approvals.find(
      (item) => path === `${accountPath}/approvals/${item.id}`,
    );
    if (approval && method === "POST") {
      const body = request.postDataJSON();
      expect(Object.keys(body).sort()).toEqual(["decision", "effectDigest"]);
      expect(["approved", "denied"]).toContain(body.decision);
      expect(
        value.operations.some(
          (item) =>
            item.id === approval.operationId &&
            item.accountId === value.account.id,
        ),
      ).toBe(true);
      if (body.effectDigest !== approval.effectDigest)
        return reply({ error: "fixture-effect-changed" }, 409);
      approval.status = body.decision;
      decisions.push({
        id: approval.id,
        operationId: approval.operationId,
        ...body,
      });
      return reply(approval);
    }
    return reply({ error: "unsupported fixture route" }, 404);
  });
  return {
    requests,
    posts,
    decisions,
    resumeTargets,
    fictionalPassword,
    credentialSubmitted: () => credentialSubmitted,
    releaseCredentials,
    verifyConnection: () => {
      const value = current();
      value.status = "connected";
      value.verifiedAt = Date.now();
      value.operations = value.operations.map((item) => ({
        ...item,
        status: "completed",
      }));
    },
    requireApproval: (id: string) => {
      const value = current();
      const operation = value.operations[0];
      if (!operation) throw new Error("Fixture operation missing");
      const approval: AccessApproval = {
        id,
        accountId: value.account.id,
        operationId: operation.id,
        description:
          "Share the fictional weekly summary with your work account.",
        effectDigest: `fixture-effect-${id}-v1`,
        status: "pending",
        createdAt: Date.now(),
        expiresAt: Date.now() + 600_000,
      };
      value.approvals = [approval];
      return approval;
    },
    changeApprovalEffect: () => {
      current().approvals[0].effectDigest += "-changed";
      current().approvals[0].description =
        "Review the updated fictional weekly summary before sharing.";
    },
  };
}

for (const viewport of [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`Access onboarding ${viewport.name}: add, private credentials, verified connection and approvals`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    const fixture = await installOnboarding(page);
    const capture = async (name: string) => {
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      const path = testInfo.outputPath(`${name}.png`);
      await page.evaluate(async () => {
        await document.fonts.ready;
      });
      await captureScreenshotWithQualityRetry(page, name, {
        path,
        fullPage: false,
      });
      await testInfo.attach(name, { path, contentType: "image/png" });
    };
    await page.goto("/embed/apps?platform=telegram");
    await expect(
      page.getByText("A place for the apps in your day"),
    ).toBeVisible();
    await capture("01-empty-drawer");
    await page.getByRole("button", { name: /Add an app/ }).click();
    await page.getByLabel("Website", { exact: true }).fill("example.com");
    await page.getByLabel("Account name (optional)").fill("Personal account");
    await capture("02-add-website");
    await page.getByRole("button", { name: "Add app", exact: true }).click();
    await expect(
      page.getByText("Ready to connect", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Connect account", exact: true })
      .click();
    const password = page.getByLabel("Password", { exact: true });
    await expect(password).toBeVisible();
    await capture("03-generated-credentials");
    await password.fill(fixture.fictionalPassword);
    await page.getByRole("button", { name: "Save and continue" }).click();
    await expect.poll(fixture.credentialSubmitted).toBe(true);
    await expect(password).toHaveValue("");
    await expect(password).toBeDisabled();
    await expect(page.getByText("Connected", { exact: true })).toHaveCount(0);
    fixture.releaseCredentials();
    await expect(page.getByText("Connecting", { exact: true })).toBeVisible();
    await expect(password).toHaveCount(0);
    await expect(page.getByText("Connected", { exact: true })).toHaveCount(0);
    await capture("04-awaiting-verification");
    expect(fixture.resumeTargets).toHaveLength(1);
    fixture.verifyConnection();
    await page.getByRole("button", { name: "Refresh connection" }).click();
    await expect(page.getByText("Connected", { exact: true })).toBeVisible();
    await capture("05-verified-connection");
    const firstApproval = fixture.requireApproval("approval-share");
    await page.getByRole("button", { name: "Refresh connection" }).click();
    await expect(
      page.getByRole("region", { name: "Permission request" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Allow this action" })
      .scrollIntoViewIfNeeded();
    await capture("06-approval-review");
    fixture.changeApprovalEffect();
    await page.getByRole("button", { name: "Allow this action" }).click();
    await expect(page.getByRole("alert")).toContainText(
      "could not be confirmed",
    );
    expect(fixture.decisions).toHaveLength(0);
    await expect(
      page.getByRole("region", { name: "Permission request" }),
    ).toBeVisible();
    await capture("07-changed-effect-refused");
    await page.getByRole("button", { name: "Refresh connection" }).click();
    await expect(
      page.getByText(
        "Review the updated fictional weekly summary before sharing.",
      ),
    ).toBeVisible();
    await page.getByRole("button", { name: "Allow this action" }).click();
    await expect(
      page.getByRole("region", { name: "Permission request" }),
    ).toHaveCount(0);
    expect(fixture.decisions).toEqual([
      {
        id: firstApproval.id,
        operationId: firstApproval.operationId,
        effectDigest: firstApproval.effectDigest,
        decision: "approved",
      },
    ]);
    const secondApproval = fixture.requireApproval("approval-deny");
    await page.getByRole("button", { name: "Refresh connection" }).click();
    await page.getByRole("button", { name: "Deny", exact: true }).click();
    await expect(
      page.getByRole("region", { name: "Permission request" }),
    ).toHaveCount(0);
    expect(fixture.decisions[1]).toEqual({
      id: secondApproval.id,
      operationId: secondApproval.operationId,
      effectDigest: secondApproval.effectDigest,
      decision: "denied",
    });
    await capture("08-decisions-complete");
    expect(
      fixture.posts
        .filter((item) => item.containsCredential)
        .map((item) => item.path),
    ).toEqual([
      expect.stringMatching(
        /^\/access\/accounts\/[^/]+\/credentials\/pending$/,
      ),
    ]);
    expect(
      fixture.posts.every(
        (item) =>
          item.path === "/api/embed/auth" ||
          item.path.startsWith("/access/accounts"),
      ),
    ).toBe(true);
    expect(
      await page.evaluate(
        (secret) =>
          !document.body.textContent?.includes(secret) &&
          !JSON.stringify(localStorage).includes(secret) &&
          !JSON.stringify(sessionStorage).includes(secret),
        fixture.fictionalPassword,
      ),
    ).toBe(true);
    await testInfo.attach("redacted-fixture-network", {
      body: JSON.stringify({
        scope: "Fictional HTTP fixture, not live backend",
        requests: fixture.requests,
        resumeCount: fixture.resumeTargets.length,
        decisions: fixture.decisions.map(({ decision }) => decision),
        credentialRequestCount: fixture.posts.filter(
          (item) => item.containsCredential,
        ).length,
      }),
      contentType: "application/json",
    });
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect(
      page.getByRole("button", { name: /Personal account/ }),
    ).toBeVisible();
  });
}
