import * as cf from "@distilled.cloud/stackit/cloud_foundry";
import { Unowned } from "alchemy/AdoptPolicy";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { readGeneration } from "../IaaS/internal.ts";
import { hasUnresolvedTrigger, rawProp, triggerProps } from "../internal/diff.ts";
import { waitUntilGone } from "../internal/wait.ts";
import {
  desiredGenerationLabels,
  hasAlchemyLabels,
  hasInstanceLabel,
  stripInternalLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  CF_HOST_MAX_LENGTH,
  deleteRouteAndWait,
  ensureDestination,
  findOwnRoute,
  findRoute,
  getRouteOrUndefined,
  JOB_TIMEOUT,
  labelUpdate,
  observedLabels,
  relationTo,
  requireGuid,
  resolveDomain,
  usableCredentials,
  withCloudFoundry,
  type CloudFoundryCredentialsProps,
} from "./internal.ts";

export interface RouteProps {
  /** Space holding the route. Changing it replaces the route. */
  spaceId: string;
  /** A user with `space_developer` in the space. Updates in place. */
  credentials: CloudFoundryCredentialsProps;
  /**
   * Name of the domain, e.g. `apps.01.cf.eu01.stackit.cloud`. Changing it replaces the
   * route.
   *
   * @default the platform's first shared HTTP domain
   */
  domain?: string;
  /**
   * Host of the route, the part before the domain. Hosts are shared across the platform's
   * shared domains, so a common one can be taken. Changing it replaces the route.
   *
   * @default a unique name generated from the stack, stage and logical ID
   */
  host?: string;
  /** Path of the route, starting with `/`. Changing it replaces the route. */
  path?: string;
  /**
   * Apps the route sends traffic to. Updates in place. A destination someone else added
   * stays.
   */
  appIds?: string[];
  /**
   * User labels. Alchemy's ownership labels are always merged in. Updates in place.
   */
  labels?: Record<string, string>;
}

export interface RouteAttributes {
  /** Cloud Foundry id of the route. */
  routeId: string;
  /** Space holding the route. */
  spaceId: string;
  /** Id of the domain. */
  domainId: string;
  /** Name of the domain. */
  domain: string;
  /** Host of the route. */
  host: string;
  /** Path of the route, if any. */
  path: string | undefined;
  /** Address the route serves, as the API reports it. */
  address: string | undefined;
  /** `https://` URL of the route. */
  url: string;
  /** Destinations this resource added, by app id. */
  destinations: Record<string, string>;
  /** User labels (Alchemy ownership labels stripped). */
  labels: Record<string, string>;
}

export type Route = Resource<
  "Stackit.CloudFoundry.Route",
  RouteProps,
  RouteAttributes,
  never,
  Providers
>;

/**
 * A route on a STACKIT Cloud Foundry platform: a host and path on a domain, sending
 * traffic to apps. A `Stackit.CloudFoundry.App` creates its own route by default, so use
 * this for a second address, a path, or a host shared by several apps.
 *
 * Changing `spaceId`, `domain`, `host` or `path` replaces the route. An explicit address
 * can't exist twice, so the old route is deleted first when it is unchanged. Destinations
 * and labels update in place.
 *
 * Ownership is tracked with Cloud Foundry labels (`alchemy.stack`, `alchemy.stage`,
 * `alchemy.id`, `alchemy.instance`). A route at the same address that lacks them is
 * reported as unowned, and only taken over with `--adopt`. `alchemy unsafe nuke` can't
 * list routes, because it has no Cloud Foundry credentials: they go with their organization.
 *
 * See [STACKIT's Cloud Foundry docs](https://docs.stackit.cloud/products/runtime/cloud-foundry/).
 *
 * :::caution[Changing the address replaces the Route]
 * Traffic to the old address stops, and it can be taken by someone else.
 * :::
 *
 * ### Creating a Route
 * **Example:** A second address for an app
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import { Deployer } from "./deployer.ts";
 *
 * const deployer = yield* Deployer;
 * const app = yield* Stackit.CloudFoundry.App("Api", {
 *   ...deployer,
 *   image: "ghcr.io/my-org/api:v1.2.3",
 * });
 * const route = yield* Stackit.CloudFoundry.Route("Www", {
 *   ...deployer,
 *   host: "orders-www",
 *   appIds: [app.appId],
 * });
 * ```
 *
 * **Example:** A path, on a named domain
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import { Deployer } from "./deployer.ts";
 *
 * const deployer = yield* Deployer;
 * const docs = yield* Stackit.CloudFoundry.App("Docs", {
 *   ...deployer,
 *   image: "ghcr.io/my-org/docs:v1.2.3",
 *   noRoute: true,
 * });
 * const route = yield* Stackit.CloudFoundry.Route("DocsRoute", {
 *   ...deployer,
 *   domain: "apps.01.cf.eu01.stackit.cloud",
 *   host: "orders",
 *   path: "/docs",
 *   appIds: [docs.appId],
 * });
 * ```
 *
 * @resource
 * @product STACKIT Cloud Foundry
 * @category CloudFoundry
 */
export const Route = Resource<Route>("Stackit.CloudFoundry.Route");

const toHost = (id: string, host: string | undefined) =>
  host !== undefined
    ? Effect.succeed(host)
    : createPhysicalName({ id, lowercase: true, maxLength: CF_HOST_MAX_LENGTH });

/** A route as the API answers it, from any of its operations. */
interface LiveRoute {
  readonly guid?: string;
  readonly host?: string;
  readonly path?: string;
  readonly url?: string;
  readonly metadata?: { readonly labels?: unknown } | undefined;
}

const toAttrs = (
  route: LiveRoute,
  routeId: string,
  spaceId: string,
  domain: { readonly domainId: string; readonly domain: string },
  destinations: Record<string, string>,
): RouteAttributes => {
  const path = route.path === "" ? undefined : route.path;
  const host = route.host ?? "";
  return {
    routeId,
    spaceId,
    domainId: domain.domainId,
    domain: domain.domain,
    host,
    path,
    address: route.url,
    url: `https://${host}.${domain.domain}${path ?? ""}`,
    destinations,
    labels: stripInternalLabels(observedLabels(route)),
  };
};

export const RouteProvider = () =>
  Provider.succeed(Route, {
    stables: ["routeId", "spaceId", "domainId", "domain", "host", "path"],
    nuke: { dependsOn: ["Stackit.CloudFoundry.Space"] },

    // Listing needs Cloud Foundry credentials, which nuke doesn't have and only state
    // holds. Routes go with their space.
    list: () => Effect.succeed([]),

    diff: Effect.fn(function* ({ id, news, olds, output }) {
      if (output === undefined) return undefined;
      // An unresolved trigger can resolve to the address the route already has, and an
      // explicit address can't exist twice. A generated host carries the generation.
      if (hasUnresolvedTrigger<RouteProps>(news, ["spaceId", "domain", "host", "path"])) {
        return {
          action: "replace",
          deleteFirst: rawProp<RouteProps>(news, "host") !== undefined,
        } as const;
      }
      const resolved = triggerProps<RouteProps>(news);
      // No `domain` takes whichever the platform shares, so it only differs from one named.
      const sameDomain =
        resolved.domain === undefined
          ? olds?.domain === undefined
          : resolved.domain === output.domain;
      const sameAddress =
        (yield* toHost(id, resolved.host)) === output.host &&
        sameDomain &&
        resolved.path === output.path;
      if (!sameAddress || resolved.spaceId !== output.spaceId) {
        return { action: "replace", deleteFirst: sameAddress } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, instanceId, olds, output, previous }) {
      if (!usableCredentials(olds?.credentials)) return undefined;
      const { credentials, spaceId } = olds;
      return yield* Effect.gen(function* () {
        let route: LiveRoute | undefined =
          output?.routeId !== undefined ? yield* getRouteOrUndefined(output.routeId) : undefined;
        const domain =
          output !== undefined
            ? { domainId: output.domainId, domain: output.domain }
            : yield* resolveDomain(id, olds.domain);
        if (route === undefined) {
          const host = output?.host ?? (yield* toHost(id, olds.host));
          route = yield* findRoute({
            spaceId: output?.spaceId ?? spaceId,
            domainId: domain.domainId,
            host,
            path: output?.path ?? olds.path,
          });
        }
        if (route?.guid === undefined) return undefined;
        const attrs = toAttrs(
          route,
          route.guid,
          output?.spaceId ?? spaceId,
          domain,
          output?.destinations ?? {},
        );
        const labels = observedLabels(route);
        if (previous?.routeId === route.guid && previous.spaceId === attrs.spaceId) return attrs;
        // Once state or a replacement exists, only this generation is ours. An older generation
        // still waiting for its delete would otherwise become the new one, and then be deleted.
        const generation = readGeneration({ instanceId, output, previous });
        const ours =
          (yield* hasAlchemyLabels(id, labels)) &&
          (generation === undefined || hasInstanceLabel(generation, labels));
        return ours ? attrs : Unowned(attrs);
      }).pipe(withCloudFoundry(id, credentials));
    }),

    reconcile: Effect.fn(function* ({ id, instanceId, news, olds, output }) {
      const { spaceId, credentials } = news;
      const labels = yield* desiredGenerationLabels(id, instanceId, news.labels);
      const host = yield* toHost(id, news.host);

      return yield* Effect.gen(function* () {
        const domain = yield* resolveDomain(id, news.domain);

        // 1. Observe. `output` only speaks for this route at this address.
        const known =
          output?.spaceId === spaceId &&
          output.domainId === domain.domainId &&
          output.host === host &&
          output.path === news.path
            ? output
            : undefined;
        let route: LiveRoute | undefined =
          known !== undefined ? yield* getRouteOrUndefined(known.routeId) : undefined;
        if (route === undefined) {
          route = yield* findOwnRoute({
            id,
            instanceId,
            spaceId,
            domainId: domain.domainId,
            host,
            path: news.path,
          });
        }

        // 2. Ensure
        if (route === undefined) {
          route = yield* cf.createRoute({
            host,
            ...(news.path !== undefined ? { path: news.path } : {}),
            relationships: {
              space: relationTo(spaceId),
              domain: relationTo(domain.domainId),
            },
            metadata: { labels },
          });
        }
        const routeId = yield* requireGuid(`route ${host}`, route);

        // 3. Sync labels against the observed ones.
        const labelChanges = labelUpdate(observedLabels(route), labels, olds?.labels);
        if (labelChanges !== undefined) {
          route = yield* cf.updateRoute({ guid: routeId, metadata: { labels: labelChanges } });
        }

        // Sync destinations: the ones desired, and the removal of those this resource added.
        const destinations: Record<string, string> = {};
        for (const appId of news.appIds ?? []) {
          const destinationId = yield* ensureDestination(routeId, appId);
          if (destinationId !== undefined) destinations[appId] = destinationId;
        }
        for (const [appId, destinationId] of Object.entries(known?.destinations ?? {})) {
          if (appId in destinations) continue;
          yield* cf
            .removeDestinationForRoute({ guid: routeId, destination_guid: destinationId })
            .pipe(Effect.catchTag("NotFound", () => Effect.void));
        }

        // 4. Return
        return toAttrs(route, routeId, spaceId, domain, destinations);
      }).pipe(withCloudFoundry(id, credentials));
    }),

    delete: Effect.fn(function* ({ id, olds, output }) {
      const resource = `Cloud Foundry route ${output.url}`;
      yield* Effect.gen(function* () {
        yield* deleteRouteAndWait(resource, output.routeId);
        yield* waitUntilGone({
          resource,
          read: getRouteOrUndefined(output.routeId),
          state: (route) => route.url,
          timeout: JOB_TIMEOUT,
        });
      }).pipe(withCloudFoundry(id, olds.credentials));
    }),
  });
