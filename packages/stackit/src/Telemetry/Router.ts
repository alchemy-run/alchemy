import * as router from "@distilled.cloud/stackit/telemetry_router";
import { Unowned } from "alchemy/AdoptPolicy";
import { deepEqual } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { readGeneration, resolveProjectScope } from "../IaaS/internal.ts";
import { hasUnresolvedTrigger, rawProp, triggerProps } from "../internal/diff.ts";
import {
  conflictRetry,
  emptyToUndefined,
  findOwnedGeneration,
  generatedDisplayName,
} from "../internal/displayNames.ts";
import { childrenLeftAfterSettling, waitFor, waitUntilGone } from "../internal/wait.ts";
import { desiredGenerationLabels, labelRecord, stripInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  getRouterOrUndefined,
  listOwnedRouters,
  listRouterAccessTokens,
  listRouterDestinations,
  listRouters,
  onRegion,
  POLL,
  TELEMETRY_TIMEOUT,
  type RouterScope,
} from "./internal.ts";

/** One attribute condition of a {@link TelemetryFilter}. */
export interface TelemetryFilterAttribute {
  /** Attribute name to match. */
  key: string;
  /** Where the attribute sits on the OTLP record. */
  level: "resource" | "scope" | "logRecord";
  /** `=` keeps a record with one of the values, `!=` keeps a record with none of them. */
  matcher: "=" | "!=";
  /** Values to compare the attribute with. */
  values: string[];
}

/** Which log records a router or a destination passes on. */
export interface TelemetryFilter {
  /** The conditions. */
  attributes: TelemetryFilterAttribute[];
  /**
   * Turn the filter off without removing it.
   * @default false
   */
  disabled?: boolean;
}

export interface RouterProps {
  /**
   * Name of the router: 1 to 32 letters, digits, spaces and hyphens, starting with a
   * letter or digit. Updates in place.
   *
   * @default a unique name generated from the stack, stage and logical ID
   */
  displayName?: string;
  /**
   * Description: letters, digits, spaces and hyphens only, at most 1024 characters.
   * Updates in place; omit to leave the live value alone.
   */
  description?: string;
  /**
   * Which records the router passes on to its destinations. Updates in place; omit to
   * leave the live filter alone, so removing this prop doesn't clear a filter. Set
   * `disabled: true` to turn one off.
   */
  filter?: TelemetryFilter;
  /**
   * User labels. Alchemy's ownership labels are always merged in. Updates in place.
   */
  labels?: Record<string, string>;
  /** Project that owns the router. Changing it replaces the router. @default the profile's project */
  projectId?: string;
  /** Region of the router. Changing it replaces the router. @default the profile's region */
  region?: string;
}

export interface RouterAttributes {
  /** STACKIT router id (UUID). Stable across updates. */
  routerId: string;
  /** Project that owns the router. */
  projectId: string;
  /** Region of the router. */
  region: string;
  /** Name of the router. */
  displayName: string;
  /** Description, if any. */
  description: string | undefined;
  /** The router's filter, if any. */
  filter: TelemetryFilter | undefined;
  /** User labels (Alchemy ownership labels stripped). */
  labels: Record<string, string>;
  /** Status; `active` after a deploy. */
  status: string;
  /** URI STACKIT reports for the router. */
  uri: string;
  /** Number of destinations on the router when it was last read. */
  destinationCount: number;
  /** When the router was created (RFC 3339). */
  creationTime: string;
}

export type Router = Resource<
  "Stackit.Telemetry.Router",
  RouterProps,
  RouterAttributes,
  never,
  Providers
>;

/** A router still has destinations or access tokens when it is deleted. */
export class RouterNotEmpty extends Data.TaggedError("Stackit.Telemetry.RouterNotEmpty")<{
  readonly routerId: string;
  readonly children: ReadonlyArray<string>;
  readonly message: string;
}> {}

/**
 * A STACKIT Telemetry Router: receives a project's, folder's or organization's audit
 * logs and forwards them to every `Stackit.Telemetry.Destination` on it, optionally
 * filtered. STACKIT's docs say the service exclusively handles audit logs, so a
 * router isn't an ingest path for your own logs, metrics or traces.
 *
 * Name, description, filter and labels update in place; moving a router to another
 * project or region replaces it. Deploys wait until the router reports `active`.
 * Destinations and access tokens are their own resources, and are deleted first. Deleting
 * a router that still has others fails with `Stackit.Telemetry.RouterNotEmpty`, which names
 * them: the API would otherwise leave the router stuck deleting until they go. Only
 * `alchemy unsafe nuke` deletes it past them, with the API's `force`.
 *
 * Ownership is tracked with labels. A router of the same name without them is
 * reported as unowned, and only taken over with `--adopt`.
 *
 * See [STACKIT's Telemetry Router docs](https://docs.stackit.cloud/products/logging-and-monitoring/telemetry-router/).
 *
 * :::caution[Changing `projectId` or `region` replaces the Router]
 * Destinations and access tokens on the old router go first. Deleting a router that
 * still has others fails with `Stackit.Telemetry.RouterNotEmpty`, which names them.
 * :::
 *
 * ### Creating a Router
 * **Example:** A router with a generated name
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const router = yield* Stackit.Telemetry.Router("AuditLogs", {});
 * ```
 *
 * **Example:** A named router in a given region
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const router = yield* Stackit.Telemetry.Router("AuditLogs", {
 *   displayName: "audit-logs",
 *   description: "Compliance export",
 *   region: "eu02",
 *   labels: { team: "security" },
 * });
 * ```
 *
 * ### Filtering Records
 * **Example:** Pass on records of one service only
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const router = yield* Stackit.Telemetry.Router("AuditLogs", {
 *   filter: {
 *     attributes: [
 *       {
 *         key: "service.name",
 *         level: "resource",
 *         matcher: "=",
 *         values: ["iam"],
 *       },
 *     ],
 *   },
 * });
 * ```
 *
 * ### Sending Logs Somewhere
 * **Example:** A router exporting to an OpenTelemetry endpoint
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const router = yield* Stackit.Telemetry.Router("AuditLogs", {});
 * yield* Stackit.Telemetry.Destination("Siem", {
 *   routerId: router.routerId,
 *   config: {
 *     type: "OpenTelemetry",
 *     uri: "https://siem.example.com/otlp/v1/logs",
 *     bearerToken: "replace-with-a-secret",
 *   },
 * });
 * ```
 *
 * ### Replacement Cautions
 * **Example:** Moving a router to another region creates a new one
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * // The destinations and access tokens on it are replaced too, and a
 * // `Stackit.Telemetry.Link` has to point at the new router.
 * const router = yield* Stackit.Telemetry.Router("AuditLogs", {
 *   region: "eu02",
 * });
 * ```
 *
 * @resource
 * @product STACKIT Telemetry Router
 * @category Telemetry
 */
export const Router = Resource<Router>("Stackit.Telemetry.Router");

const toFilter = (filter: router.ConfigFilter | undefined): TelemetryFilter | undefined =>
  filter === undefined
    ? undefined
    : {
        attributes: filter.attributes.map((attribute) => ({
          key: attribute.key,
          // The API's open enums: anything it returns goes back to it unchanged.
          level: attribute.level as TelemetryFilterAttribute["level"],
          matcher: attribute.matcher as TelemetryFilterAttribute["matcher"],
          values: [...attribute.values],
        })),
        ...(filter.disabled !== undefined ? { disabled: filter.disabled } : {}),
      };

const toRequestFilter = (filter: TelemetryFilter): router.ConfigFilter => ({
  attributes: filter.attributes.map((attribute) => ({
    ...attribute,
    values: [...attribute.values],
  })),
  ...(filter.disabled !== undefined ? { disabled: filter.disabled } : {}),
});

/** Whether a live filter says what the props say. An unset `disabled` means `false`. */
export const filterEquals = (observed: router.ConfigFilter | undefined, desired: TelemetryFilter) =>
  observed !== undefined &&
  (observed.disabled ?? false) === (desired.disabled ?? false) &&
  deepEqual(observed.attributes, desired.attributes);

const toAttrs = (scope: RouterScope, live: router.TelemetryRouterResponse): RouterAttributes => ({
  routerId: live.id,
  projectId: scope.projectId,
  region: scope.region,
  displayName: live.displayName,
  description: emptyToUndefined(live.description),
  filter: toFilter(live.filter),
  labels: stripInternalLabels(live.resourceLabels),
  status: live.status,
  uri: live.uri,
  destinationCount: live.destinationCount ?? 0,
  creationTime: live.creationTime,
});

type RouterPatch = Omit<
  router.PartialUpdateTelemetryRouterRequest,
  "projectId" | "regionId" | "telemetryRouterId"
>;

/** The delta between a live router and the desired props (empty when in sync). */
const routerDelta = (
  live: router.TelemetryRouterResponse,
  news: RouterProps,
  displayName: string,
  labels: Record<string, string>,
): RouterPatch => ({
  ...(live.displayName !== displayName ? { displayName } : {}),
  ...(news.description !== undefined && (live.description ?? "") !== news.description
    ? { description: news.description }
    : {}),
  ...(news.filter !== undefined && !filterEquals(live.filter, news.filter)
    ? { filter: toRequestFilter(news.filter) }
    : {}),
  // Compared with the observed labels; the full map is sent.
  ...(deepEqual(labelRecord(live.resourceLabels), labels) ? {} : { resourceLabels: labels }),
});

const isDesired = (patch: RouterPatch, live: router.TelemetryRouterResponse) =>
  (patch.displayName === undefined || live.displayName === patch.displayName) &&
  (patch.description === undefined || (live.description ?? "") === patch.description) &&
  (patch.filter === undefined || deepEqual(live.filter?.attributes, patch.filter.attributes)) &&
  // Only that the desired labels are there, so a PATCH that merges labels can't stall this.
  Object.entries(patch.resourceLabels ?? {}).every(
    ([key, value]) => labelRecord(live.resourceLabels)[key] === value,
  );

const waitForActive = (
  scope: RouterScope,
  telemetryRouterId: string,
  applied: (live: router.TelemetryRouterResponse) => boolean = () => true,
) =>
  waitFor({
    resource: `STACKIT Telemetry Router ${telemetryRouterId}`,
    read: router.getTelemetryRouter({ ...onRegion(scope), telemetryRouterId }),
    ready: (live) => live.status === "active" && applied(live),
    // A router being deleted won't become active (the Go SDK's error state).
    failed: (live) => live.status === "deleting",
    state: (live) => live.status,
    timeout: TELEMETRY_TIMEOUT,
    ...POLL,
  });

const waitForGone = (scope: RouterScope, telemetryRouterId: string) =>
  waitUntilGone({
    resource: `STACKIT Telemetry Router ${telemetryRouterId}`,
    read: getRouterOrUndefined(scope, telemetryRouterId),
    state: (live) => live.status,
    timeout: TELEMETRY_TIMEOUT,
    ...POLL,
  });

/**
 * Refuse before the delete: with children left, the API puts the router into `deleting` and
 * keeps it there, which can't be taken back. What a destroy deleted is gone by now, so what
 * remains is someone else's.
 */
const assertNoChildren = (scope: RouterScope, routerId: string) =>
  Effect.gen(function* () {
    const left = yield* childrenLeftAfterSettling(
      Effect.all(
        [listRouterDestinations(scope, routerId), listRouterAccessTokens(scope, routerId)],
        { concurrency: 2 },
      ).pipe(
        Effect.map(([destinations, tokens]) => [
          ...destinations.map((item) => `destination ${item.displayName}`),
          ...tokens.map((item) => `access token ${item.displayName}`),
        ]),
      ),
    );
    if (left.length === 0) return;
    return yield* new RouterNotEmpty({
      routerId,
      children: left,
      message: `Telemetry Router ${routerId} still has ${left.join(", ")}. Deleting it would leave it stuck deleting until they go. Delete them first.`,
    });
  });

export const RouterProvider = () =>
  Provider.succeed(Router, {
    stables: ["routerId", "projectId", "region"],

    list: Effect.fn(function* () {
      const scope = yield* resolveProjectScope(undefined, undefined);
      const owned = yield* listOwnedRouters(scope);
      return owned.map((live) => toAttrs(scope, live));
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      // An unresolved project or region can resolve to the one the router is in. A
      // generated name carries the generation, an explicit one survives it.
      if (hasUnresolvedTrigger<RouterProps>(news, ["projectId", "region"])) {
        return {
          action: "replace",
          deleteFirst: rawProp<RouterProps>(news, "displayName") !== undefined,
        } as const;
      }
      const resolved = triggerProps<RouterProps>(news);
      const scope = yield* resolveProjectScope(resolved, undefined);
      if (scope.projectId !== output.projectId || scope.region !== output.region) {
        return { action: "replace", deleteFirst: false } as const;
      }
      // Everything else updates in place (engine default: props changed).
      return undefined;
    }),

    read: Effect.fn(function* ({ id, instanceId, olds, output, previous }) {
      const scope = yield* resolveProjectScope(olds, output);
      if (output?.routerId !== undefined) {
        const byId = yield* getRouterOrUndefined(scope, output.routerId);
        if (byId !== undefined && byId.status !== "deleting") return toAttrs(scope, byId);
      }
      const routers = (yield* listRouters(scope)).filter((live) => live.status !== "deleting");
      const generation = readGeneration({ instanceId, output, previous });
      const owned = yield* findOwnedGeneration(
        id,
        generation,
        routers,
        (live) => live.resourceLabels,
      );
      if (owned !== undefined) return toAttrs(scope, owned);
      const name = output?.displayName ?? olds?.displayName ?? (yield* generatedDisplayName(id));
      const named = routers.find((live) => live.displayName === name);
      if (named === undefined) return undefined;
      const attrs = toAttrs(scope, named);
      return previous?.routerId === named.id ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, instanceId, news, output }) {
      const scope = yield* resolveProjectScope(news, output);
      const displayName =
        news.displayName ?? output?.displayName ?? (yield* generatedDisplayName(id));
      const labels = yield* desiredGenerationLabels(id, instanceId, news.labels);

      // 1. Observe — `output` is a cache for the id, and only speaks for this router
      // while it sits in the desired project and region. Without it, only this
      // generation's router can be claimed, by its labels.
      let live: router.TelemetryRouterResponse | undefined;
      if (output?.projectId === scope.projectId && output.region === scope.region) {
        live = yield* getRouterOrUndefined(scope, output.routerId);
      }
      if (live === undefined) {
        const routers = yield* listRouters(scope);
        live = yield* findOwnedGeneration(id, instanceId, routers, (item) => item.resourceLabels);
      }
      // A delete in flight (an interrupted destroy): let it finish.
      if (live?.status === "deleting") {
        yield* waitForGone(scope, live.id);
        live = undefined;
      }

      // 2. Ensure
      if (live === undefined) {
        live = yield* router
          .createTelemetryRouter({
            ...onRegion(scope),
            displayName,
            resourceLabels: labels,
            ...(news.description !== undefined ? { description: news.description } : {}),
            ...(news.filter !== undefined ? { filter: toRequestFilter(news.filter) } : {}),
          })
          .pipe(Effect.retry(conflictRetry));
      }
      const routerId = live.id;
      live = yield* waitForActive(scope, routerId);

      // 3. Sync — one PATCH carrying every drifted aspect, diffed against the live router.
      const patch = routerDelta(live, news, displayName, labels);
      if (Object.keys(patch).length > 0) {
        yield* router
          .partialUpdateTelemetryRouter({
            ...onRegion(scope),
            telemetryRouterId: routerId,
            ...patch,
          })
          .pipe(Effect.retry(conflictRetry));
        live = yield* waitForActive(scope, routerId, (observed) => isDesired(patch, observed));
      }

      // 4. Return
      return toAttrs(scope, live);
    }),

    delete: Effect.fn(function* ({ output, force }) {
      const scope = { projectId: output.projectId, region: output.region };
      const live = yield* getRouterOrUndefined(scope, output.routerId);
      if (live === undefined) return;
      if (live.status !== "deleting") {
        // Only `alchemy unsafe nuke` deletes a router past children that aren't in a stack.
        if (!force) yield* assertNoChildren(scope, output.routerId);
        yield* router
          .deleteTelemetryRouter({
            ...onRegion(scope),
            telemetryRouterId: output.routerId,
            ...(force ? { force: true } : {}),
          })
          .pipe(
            Effect.retry(conflictRetry),
            Effect.catchTag("NotFound", () => Effect.void),
          );
      }
      yield* waitForGone(scope, output.routerId);
    }),
  });
