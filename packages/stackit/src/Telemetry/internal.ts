/**
 * Shared scaffolding for the STACKIT Telemetry Router resources. Not exported from
 * the namespace barrel.
 */
import * as router from "@distilled.cloud/stackit/telemetry_router";
import * as Effect from "effect/Effect";
import { collectTokenPages, MAX_PAGE_SIZE } from "../internal/displayNames.ts";
import { isAlchemyOwned } from "../Labels.ts";

/** Where a router lives: every API path carries both. */
export interface RouterScope {
  projectId: string;
  region: string;
}

/** Create, update and delete budget (the Go SDK's wait handlers, 10 minutes). */
export const TELEMETRY_TIMEOUT = "10 minutes";

/** Polling for an operation the Go SDK gives minutes. */
export const POLL = { interval: "2 seconds", maxInterval: "15 seconds" } as const;

/** The API's path parameters for a scope. */
export const onRegion = (scope: RouterScope) => ({
  projectId: scope.projectId,
  regionId: scope.region,
});

/** `GetTelemetryRouter`; `undefined` once the router is gone. */
export const getRouterOrUndefined = (scope: RouterScope, telemetryRouterId: string) =>
  router
    .getTelemetryRouter({ ...onRegion(scope), telemetryRouterId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

/** Every router of a project in a region. */
export const listRouters = (scope: RouterScope) =>
  collectTokenPages(
    "STACKIT Telemetry Routers",
    (pageToken) =>
      router.listTelemetryRouters({
        ...onRegion(scope),
        pageSize: MAX_PAGE_SIZE,
        ...(pageToken !== undefined ? { pageToken } : {}),
      }),
    (page) => page.telemetryRouters,
  );

/** Every router Alchemy created in a project and region. */
export const listOwnedRouters = (scope: RouterScope) =>
  listRouters(scope).pipe(
    Effect.map((routers) => routers.filter((item) => isAlchemyOwned(item.resourceLabels))),
  );

/** Every destination on a router. */
export const listRouterDestinations = (scope: RouterScope, telemetryRouterId: string) =>
  collectTokenPages(
    "STACKIT Telemetry Router destinations",
    (pageToken) =>
      router.listDestinations({
        ...onRegion(scope),
        telemetryRouterId,
        pageSize: MAX_PAGE_SIZE,
        ...(pageToken !== undefined ? { pageToken } : {}),
      }),
    (page) => page.destinations,
  );

/** Every access token of a router. */
export const listRouterAccessTokens = (scope: RouterScope, telemetryRouterId: string) =>
  collectTokenPages(
    "STACKIT Telemetry Router access tokens",
    (pageToken) =>
      router.listAccessTokens({
        ...onRegion(scope),
        telemetryRouterId,
        pageSize: MAX_PAGE_SIZE,
        ...(pageToken !== undefined ? { pageToken } : {}),
      }),
    (page) => page.accessTokens,
  );
