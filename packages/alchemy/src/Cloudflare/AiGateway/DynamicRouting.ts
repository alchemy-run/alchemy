import * as aiGateway from "@distilled.cloud/cloudflare/ai-gateway";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";
import { deepEqual, isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const AiGatewayDynamicRoutingTypeId =
  "Cloudflare.AiGateway.DynamicRouting" as const;
type AiGatewayDynamicRoutingTypeId = typeof AiGatewayDynamicRoutingTypeId;

/**
 * Reference to another element in the route graph.
 */
export type AiGatewayRouteEdge = {
  /**
   * The `id` of the element the edge points at.
   */
  elementId: string;
};

/**
 * Entry point of the route graph. Every route has exactly one.
 */
export type AiGatewayRouteStartElement = {
  /**
   * Unique element identifier within the route graph.
   */
  id: string;
  type: "start";
  /**
   * The element executed first.
   */
  outputs: { next: AiGatewayRouteEdge };
};

/**
 * Branches the request based on conditions over request metadata.
 */
export type AiGatewayRouteConditionalElement = {
  /**
   * Unique element identifier within the route graph.
   */
  id: string;
  type: "conditional";
  /**
   * Conditions evaluated against the request.
   */
  properties: { conditions?: unknown };
  /**
   * Edges taken when the conditions evaluate true / false.
   */
  outputs: { true: AiGatewayRouteEdge; false: AiGatewayRouteEdge };
};

/**
 * Splits traffic across multiple edges by percentage.
 */
export type AiGatewayRoutePercentageElement = {
  /**
   * Unique element identifier within the route graph.
   */
  id: string;
  type: "percentage";
  /**
   * Percentage-weighted edges.
   */
  outputs: Record<string, unknown>;
};

/**
 * Applies a rate limit; requests over the limit take the fallback edge.
 */
export type AiGatewayRouteRateElement = {
  /**
   * Unique element identifier within the route graph.
   */
  id: string;
  type: "rate";
  properties: {
    /**
     * Key the limit is bucketed by.
     */
    key: string;
    /**
     * Maximum count/cost allowed inside the window.
     */
    limit: number;
    /**
     * Whether the limit counts requests or cost.
     */
    limitType: "count" | "cost";
    /**
     * Window size in seconds.
     */
    window: number;
  };
  /**
   * Edges taken when under (success) or over (fallback) the limit.
   */
  outputs: { success: AiGatewayRouteEdge; fallback: AiGatewayRouteEdge };
};

/**
 * Sends the request to a provider/model; failures take the fallback edge.
 */
export type AiGatewayRouteModelElement = {
  /**
   * Unique element identifier within the route graph.
   */
  id: string;
  type: "model";
  properties: {
    /**
     * Provider slug (e.g. `workers-ai`, `openai`, `anthropic`).
     */
    provider: string;
    /**
     * Model identifier (e.g. `@cf/meta/llama-3.1-8b-instruct`).
     */
    model: string;
    /**
     * Number of retries before taking the fallback edge.
     */
    retries: number;
    /**
     * Request timeout in milliseconds.
     */
    timeout: number;
  };
  /**
   * Edges taken on success / failure.
   */
  outputs: { success: AiGatewayRouteEdge; fallback: AiGatewayRouteEdge };
};

/**
 * Terminal element of the route graph.
 */
export type AiGatewayRouteEndElement = {
  /**
   * Unique element identifier within the route graph.
   */
  id: string;
  type: "end";
  /**
   * Always empty.
   */
  outputs: Record<string, never>;
};

/**
 * A node in an AI Gateway dynamic routing graph. A well-formed graph starts
 * at a `start` element and every path terminates at an `end` element.
 */
export type AiGatewayRouteElement =
  | AiGatewayRouteStartElement
  | AiGatewayRouteConditionalElement
  | AiGatewayRoutePercentageElement
  | AiGatewayRouteRateElement
  | AiGatewayRouteModelElement
  | AiGatewayRouteEndElement;

export type AiGatewayDynamicRoutingProps = {
  /**
   * The AI Gateway the route belongs to. Changing the gateway triggers a
   * replacement.
   */
  gatewayId: string;
  /**
   * Route name, unique within the gateway. If omitted, a unique name is
   * generated from the app, stage, and logical ID. Renames are applied in
   * place.
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * The element graph describing how requests are routed. Changing the
   * graph creates a new route version and deploys it.
   */
  elements: AiGatewayRouteElement[];
};

export type AiGatewayDynamicRoutingAttributes = {
  /**
   * Server-generated route identifier. Stable across updates.
   */
  routeId: string;
  /**
   * The Cloudflare account the route belongs to.
   */
  accountId: string;
  /**
   * The AI Gateway the route belongs to.
   */
  gatewayId: string;
  /**
   * Route name.
   */
  name: string;
  /**
   * The element graph of the currently deployed route version.
   */
  elements: AiGatewayRouteElement[];
  /**
   * Identifier of the currently deployed route version.
   */
  versionId: string;
  /**
   * Identifier of the active deployment.
   */
  deploymentId: string;
  /**
   * When the route was created.
   */
  createdAt: string;
  /**
   * When the route was last modified.
   */
  modifiedAt: string;
};

export type AiGatewayDynamicRouting = Resource<
  AiGatewayDynamicRoutingTypeId,
  AiGatewayDynamicRoutingProps,
  AiGatewayDynamicRoutingAttributes,
  never,
  Providers
>;

/**
 * A dynamic routing configuration ("route") on a Cloudflare AI Gateway.
 *
 * Dynamic routing models request handling as a graph of elements — start,
 * conditional, percentage split, rate limit, model, and end nodes — so a
 * single gateway endpoint can A/B test models, enforce per-user budgets, and
 * fall back between providers without app changes.
 *
 * Cloudflare versions route configurations: changing `elements` creates a
 * new version and deploys it; the reconciler also re-deploys when the live
 * deployed version drifts from the desired graph. Renames are applied in
 * place; only moving the route to a different gateway forces a replacement.
 * @resource
 * @product AI Gateway
 * @category AI
 * @section Creating a Route
 * @example Route all traffic to one model
 * ```typescript
 * const gateway = yield* Cloudflare.AiGateway("Gateway");
 *
 * const route = yield* Cloudflare.AiGatewayDynamicRouting("Llama", {
 *   gatewayId: gateway.gatewayId,
 *   elements: [
 *     { id: "start", type: "start", outputs: { next: { elementId: "model" } } },
 *     {
 *       id: "model",
 *       type: "model",
 *       properties: {
 *         provider: "workers-ai",
 *         model: "@cf/meta/llama-3.1-8b-instruct",
 *         retries: 1,
 *         timeout: 30000,
 *       },
 *       outputs: {
 *         success: { elementId: "end" },
 *         fallback: { elementId: "end" },
 *       },
 *     },
 *     { id: "end", type: "end", outputs: {} },
 *   ],
 * });
 * ```
 *
 * @section Updating a Route
 * @example Change the model — creates and deploys a new version
 * ```typescript
 * const route = yield* Cloudflare.AiGatewayDynamicRouting("Llama", {
 *   gatewayId: gateway.gatewayId,
 *   elements: [
 *     { id: "start", type: "start", outputs: { next: { elementId: "model" } } },
 *     {
 *       id: "model",
 *       type: "model",
 *       properties: {
 *         provider: "workers-ai",
 *         model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
 *         retries: 2,
 *         timeout: 60000,
 *       },
 *       outputs: {
 *         success: { elementId: "end" },
 *         fallback: { elementId: "end" },
 *       },
 *     },
 *     { id: "end", type: "end", outputs: {} },
 *   ],
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/ai-gateway/features/dynamic-routing/
 */
export const AiGatewayDynamicRouting = Resource<AiGatewayDynamicRouting>(
  AiGatewayDynamicRoutingTypeId,
);

/**
 * Returns true if the given value is an AiGatewayDynamicRouting resource.
 */
export const isAiGatewayDynamicRouting = (
  value: unknown,
): value is AiGatewayDynamicRouting =>
  Predicate.hasProperty(value, "Type") &&
  value.Type === AiGatewayDynamicRoutingTypeId;

export const AiGatewayDynamicRoutingProvider = () =>
  Provider.succeed(AiGatewayDynamicRouting, {
    stables: ["routeId", "accountId", "gatewayId", "createdAt"],
    diff: Effect.fn(function* ({ olds, news, output }) {
      if (!isResolved(news)) return undefined;
      const { accountId } = yield* yield* CloudflareEnvironment;
      if ((output?.accountId ?? accountId) !== accountId) {
        return { action: "replace" } as const;
      }
      // The gateway is a path parameter — a route cannot move between
      // gateways in place. By diff time both sides are resolved strings.
      const oldGatewayId = output?.gatewayId ?? olds?.gatewayId;
      if (
        typeof oldGatewayId === "string" &&
        typeof news.gatewayId === "string" &&
        oldGatewayId !== news.gatewayId
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ id, olds, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;
      const gatewayId =
        output?.gatewayId ?? (olds?.gatewayId as string | undefined);
      if (gatewayId === undefined) return undefined;

      if (output?.routeId) {
        const observed = yield* getRoute(acct, gatewayId, output.routeId);
        return observed ? toAttributes(observed, acct) : undefined;
      }
      // Cold read — recover from lost state by matching the deterministic
      // physical name. Route names are unique within a gateway, so an exact
      // match identifies the route.
      const name = yield* createRouteName(id, olds?.name);
      const match = yield* findByName(acct, gatewayId, name);
      if (match) {
        const observed = yield* getRoute(acct, gatewayId, match.id);
        return observed ? toAttributes(observed, acct) : undefined;
      }
      return undefined;
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const gatewayId = news.gatewayId as string;
      const name = yield* createRouteName(id, news.name);
      const desired = news.elements ?? [];

      // Observe — the routeId cached on `output` is a hint, not a
      // guarantee: a missing route falls through and we recreate.
      const observed = output?.routeId
        ? yield* getRoute(
            output.accountId ?? accountId,
            gatewayId,
            output.routeId,
          )
        : undefined;

      // Ensure — create if missing. Route names are unique per gateway:
      // tolerate the `RouteAlreadyExists` race (a peer reconciler created
      // it concurrently, or state persistence failed after a previous
      // create) by recovering the existing route by name.
      const routeId =
        observed?.id ??
        (yield* aiGateway
          .createDynamicRouting({
            accountId,
            gatewayId,
            name,
            elements: desired,
          })
          .pipe(
            Effect.catchTag("RouteAlreadyExists", (error) =>
              findByName(accountId, gatewayId, name).pipe(
                Effect.flatMap((match) =>
                  match ? Effect.succeed(match) : Effect.fail(error),
                ),
              ),
            ),
            Effect.map((route) => route.id),
          ));

      // Sync — observed cloud state is the diff baseline. Creation above
      // auto-deploys version 1, so a fresh `get` covers all paths.
      const current = yield* aiGateway.getDynamicRouting({
        accountId,
        gatewayId,
        id: routeId,
      });

      if (current.name !== name) {
        yield* aiGateway.patchDynamicRouting({
          accountId,
          gatewayId,
          id: routeId,
          name,
        });
      }

      // `get` returns the *deployed* version's graph, so an undeployed
      // draft version naturally shows up as drift and gets re-deployed.
      const observedElements = elementsOf(current);
      if (!deepEqual(observedElements, desired)) {
        const version = yield* aiGateway.createVersionDynamicRouting({
          accountId,
          gatewayId,
          id: routeId,
          elements: desired,
        });
        yield* aiGateway.createDeploymentDynamicRouting({
          accountId,
          gatewayId,
          id: routeId,
          versionId: version.versionId,
        });
      }

      // Return — re-read the final state so attributes reflect the
      // deployed version, not stale intermediate responses.
      const final = yield* aiGateway.getDynamicRouting({
        accountId,
        gatewayId,
        id: routeId,
      });
      return toAttributes(final, accountId);
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* aiGateway
        .deleteDynamicRouting({
          accountId: output.accountId,
          gatewayId: output.gatewayId,
          id: output.routeId,
        })
        .pipe(
          // Route already gone — or the whole parent gateway is gone.
          Effect.catchTag("RouteNotFound", () => Effect.void),
          Effect.catchTag("GatewayNotFound", () => Effect.void),
        );
    }),
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // Routes are scoped under a gateway and there is no account-wide
      // route list, so fan out: enumerate every account gateway, then
      // exhaustively list each gateway's routes.
      const gateways = yield* aiGateway.listAiGateways
        .pages({ accountId })
        .pipe(
          Stream.runCollect,
          Effect.map((chunk) =>
            Array.from(chunk).flatMap((page) => page.result ?? []),
          ),
        );
      const rows = yield* Effect.forEach(
        gateways,
        (gateway) =>
          listRoutes(accountId, gateway.id).pipe(
            // A gateway removed between enumeration and its route list is
            // gone — skip it rather than failing the whole listing.
            Effect.catchTag("GatewayNotFound", () =>
              Effect.succeed([] as AiGatewayDynamicRoutingAttributes[]),
            ),
          ),
        { concurrency: 10 },
      );
      return rows.flat();
    }),
  });

/**
 * Exhaustively list every route in a gateway. `listDynamicRoutings` is not a
 * paginated distilled operation (the Cloudflare response carries only
 * `page`/`per_page`, no total), so page manually until a short page signals
 * the end.
 *
 * The list endpoint omits each route's element graph — its items carry only
 * deployment/version metadata, no `version.data` — so hydrate every route with
 * a per-route `get` to populate `elements` into the exact `read` shape.
 */
const listRoutes = (accountId: string, gatewayId: string) =>
  Effect.gen(function* () {
    const perPage = 50;
    const ids: string[] = [];
    for (let page = 1; ; page++) {
      const response = yield* aiGateway.listDynamicRoutings({
        accountId,
        gatewayId,
        page,
        perPage,
      });
      const routes = response.data.routes;
      for (const route of routes) {
        ids.push(route.id);
      }
      if (routes.length < perPage) break;
    }
    const hydrated = yield* Effect.forEach(
      ids,
      (id) => getRoute(accountId, gatewayId, id),
      { concurrency: 10 },
    );
    return hydrated
      .filter((r) => r !== undefined)
      .map((route) => toAttributes(route, accountId));
  });

/**
 * Read a route by id, mapping "gone" (`RouteNotFound`, Cloudflare error code
 * 7005, or `GatewayNotFound`, code 7002, when the parent gateway was
 * deleted) to `undefined`.
 */
const getRoute = (accountId: string, gatewayId: string, id: string) =>
  aiGateway.getDynamicRouting({ accountId, gatewayId, id }).pipe(
    Effect.catchTag("RouteNotFound", () => Effect.succeed(undefined)),
    Effect.catchTag("GatewayNotFound", () => Effect.succeed(undefined)),
  );

/**
 * Find a route by exact name. Route names are unique within a gateway. A
 * missing parent gateway means the route is gone too.
 */
const findByName = (accountId: string, gatewayId: string, name: string) =>
  aiGateway.listDynamicRoutings({ accountId, gatewayId, perPage: 50 }).pipe(
    Effect.map((list) => list.data.routes.find((r) => r.name === name)),
    Effect.catchTag("GatewayNotFound", () => Effect.succeed(undefined)),
  );

const createRouteName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    return name ?? (yield* createPhysicalName({ id, lowercase: true }));
  });

/**
 * The deployed element graph. Cloudflare returns it as `version.data` (the
 * distilled schema types it `unknown` because the public spec wrongly
 * declares it a string).
 */
const elementsOf = (
  route: aiGateway.GetDynamicRoutingResponse,
): AiGatewayRouteElement[] =>
  (route.version.data ?? []) as AiGatewayRouteElement[];

const toAttributes = (
  route: aiGateway.GetDynamicRoutingResponse,
  accountId: string,
): AiGatewayDynamicRoutingAttributes => ({
  routeId: route.id,
  accountId,
  gatewayId: route.gatewayId,
  name: route.name,
  elements: elementsOf(route),
  versionId: route.deployment.versionId,
  deploymentId: route.deployment.deploymentId,
  createdAt: route.createdAt,
  modifiedAt: route.modifiedAt,
});
