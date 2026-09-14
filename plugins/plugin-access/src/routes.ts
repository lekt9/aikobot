/** Authenticated protocol translation for the Mini App; credential values never enter planner context or diagnostics. */
import {
  ElizaError,
  type IAgentRuntime,
  type Route,
  type RouteHandlerContext,
  type RouteHandlerResult,
} from "@elizaos/core";
import {
  AccessClientError,
  accountIdSchema,
  browserActionSchema,
  browserResumeSchema,
  operationIdSchema,
  operationInputSchema,
} from "access/client";
import { z } from "zod";
import { accessFailure, ownerFromBoundary } from "./contracts.ts";
import type { AccessCoordinator } from "./coordinator.ts";
import {
  pollInputSchema,
  scheduleAccessRefresh,
  scheduleAccessWatcher,
  watcherInputSchema,
} from "./scheduling.ts";
import { accessCoordinator } from "./service.ts";

const addSchema = z
  .object({
    id: accountIdSchema,
    site: z.string().min(1),
    label: z.string().optional(),
  })
  .strict();
const credentialsSchema = z
  .object({
    id: z.string().min(1),
    values: z.record(z.string(), z.string().min(1)),
  })
  .strict();
const approvalInput = z
  .object({
    decision: z.enum(["approved", "denied"]),
    effectDigest: z.string().min(1),
  })
  .strict();

export function createAccessRoutes(
  resolve: (runtime: IAgentRuntime) => AccessCoordinator = accessCoordinator,
): Route[] {
  const route = (
    type: Route["type"],
    path: string,
    action: (
      context: RouteHandlerContext,
      coordinator: AccessCoordinator,
      ownerId: ReturnType<typeof ownerFromBoundary>,
    ) => Promise<unknown>,
  ): Route => ({
    type,
    path,
    routeHandler: async (context): Promise<RouteHandlerResult> => {
      try {
        const ownerId = ownerFromBoundary(context.accessContext);
        const coordinator = resolve(context.runtime);
        return {
          status: 200,
          headers: { "cache-control": "no-store" },
          body: await action(context, coordinator, ownerId),
        };
      } catch (error) {
        // error-policy:J1 Translate only reviewed codes; never serialize request bodies or external diagnostic text.
        if (error instanceof z.ZodError)
          return { status: 400, body: { error: "ACCESS_INVALID_REQUEST" } };
        if (error instanceof AccessClientError)
          return {
            status: error.status >= 400 ? error.status : 503,
            body: { error: `ACCESS_${error.code.toUpperCase()}` },
          };
        if (
          error instanceof ElizaError &&
          error.code === "ACCESS_OWNER_REQUIRED"
        )
          return { status: 401, body: { error: error.code } };
        if (
          error instanceof ElizaError &&
          error.code === "ACCESS_TELEGRAM_OWNER_TARGET_REQUIRED"
        )
          return { status: 409, body: { error: error.code } };
        const failure = accessFailure("ACCESS_ROUTE_FAILED", error);
        context.runtime.reportError("AccessService.route", failure);
        return { status: 503, body: { error: failure.code } };
      }
    },
  });
  const accountId = (context: RouteHandlerContext) =>
    accountIdSchema.parse(context.params.accountId);
  return [
    route("GET", "/accounts", async (_ctx, service, owner) => {
      const result = await service.client(owner).accounts.list();
      await service.enroll(owner);
      return result;
    }),
    route("POST", "/accounts", async (ctx, service, owner) => {
      const input = addSchema.parse(ctx.body);
      const result = await service.client(owner).accounts.add(input);
      await service.enroll(owner);
      return result;
    }),
    route("PATCH", "/accounts/:accountId", (ctx, service, owner) =>
      service
        .client(owner)
        .accounts.rename(
          accountId(ctx),
          z.object({ label: z.string() }).strict().parse(ctx.body).label,
        ),
    ),
    route("DELETE", "/accounts/:accountId", (ctx, service, owner) =>
      service.client(owner).accounts.revoke(accountId(ctx)),
    ),
    route("GET", "/accounts/:accountId/connection", (ctx, service, owner) =>
      service.client(owner).accounts.connection(accountId(ctx)),
    ),
    route(
      "GET",
      "/accounts/:accountId/browser/handoffs/:handoffId/frame",
      (ctx, service, owner) =>
        service
          .client(owner)
          .accounts.browser.frame(
            accountId(ctx),
            operationIdSchema.parse(ctx.params.handoffId),
          ),
    ),
    route(
      "POST",
      "/accounts/:accountId/browser/handoffs/:handoffId/actions",
      (ctx, service, owner) =>
        service
          .client(owner)
          .accounts.browser.act(
            accountId(ctx),
            operationIdSchema.parse(ctx.params.handoffId),
            browserActionSchema.parse(ctx.body),
          ),
    ),
    route(
      "POST",
      "/accounts/:accountId/browser/handoffs/:handoffId/resume",
      (ctx, service, owner) =>
        service
          .client(owner)
          .accounts.browser.resume(
            accountId(ctx),
            operationIdSchema.parse(ctx.params.handoffId),
            browserResumeSchema.parse(ctx.body),
          ),
    ),
    route(
      "GET",
      "/accounts/:accountId/credentials/pending",
      (ctx, service, owner) =>
        service.client(owner).accounts.credentials.pending(accountId(ctx)),
    ),
    route(
      "POST",
      "/accounts/:accountId/credentials/pending",
      (ctx, service, owner) => {
        const input = credentialsSchema.parse(ctx.body);
        return service
          .client(owner)
          .accounts.credentials.fulfill(accountId(ctx), input.id, input.values);
      },
    ),
    route(
      "POST",
      "/accounts/:accountId/operations",
      async (ctx, service, owner) => {
        const input = operationInputSchema.parse(ctx.body);
        await service.enroll(owner);
        return service.client(owner).accounts.submit(accountId(ctx), input);
      },
    ),
    route(
      "POST",
      "/accounts/:accountId/approvals/:approvalId",
      (ctx, service, owner) => {
        const input = approvalInput.parse(ctx.body);
        return service
          .client(owner)
          .accounts.approve(
            accountId(ctx),
            z.string().min(1).parse(ctx.params.approvalId),
            input.decision,
            input.effectDigest,
          );
      },
    ),
    route("GET", "/accounts/:accountId/workflows", (ctx, service, owner) =>
      service.client(owner).accounts.workflows(accountId(ctx)),
    ),
    route(
      "POST",
      "/accounts/:accountId/watchers",
      async (ctx, service, owner) => {
        const id = accountId(ctx);
        const input = watcherInputSchema.parse(ctx.body);
        await service.client(owner).accounts.connection(id);
        await service.enroll(owner);
        return scheduleAccessWatcher(ctx.runtime, owner, id, input);
      },
    ),
    route("POST", "/accounts/:accountId/polls", async (ctx, service, owner) => {
      const id = accountId(ctx);
      const input = pollInputSchema.parse(ctx.body);
      await service.client(owner).accounts.connection(id);
      await service.enroll(owner);
      return scheduleAccessRefresh(ctx.runtime, owner, id, input);
    }),
    route("GET", "/context", (_ctx, service, owner) => service.context(owner)),
    route("GET", "/events", (ctx, service, owner) =>
      service.client(owner).events(
        z.coerce
          .number()
          .int()
          .nonnegative()
          .parse(ctx.query.after ?? "0"),
      ),
    ),
  ];
}
