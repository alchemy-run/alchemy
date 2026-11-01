import * as ipLists from "@distilled.cloud/stackit/lb_ip_lists";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { StackitEnvironment } from "../Environment.ts";
import {
  projectScopeChanged,
  resolveProjectScope,
  type ProjectScope,
  type ProjectScopedProps,
} from "../IaaS/internal.ts";
import { hasUnresolvedTrigger, rawProp, triggerProps } from "../internal/diff.ts";
import { ensureServiceEnabled } from "../internal/enable.ts";
import { sameMembers } from "../internal/equal.ts";
import { retryWhileInUse } from "../internal/wait.ts";
import {
  desiredLabels,
  hasAlchemyLabels,
  isAlchemyOwned,
  labelsChanged,
  stripInternalLabels,
  systemLabels,
  withoutSystemLabels,
} from "../Labels.ts";
import { LOAD_BALANCER_SERVICE_ID } from "../LoadBalancer/internal.ts";
import type { Providers } from "../Providers.ts";
import { getIPListOrUndefined, physicalName } from "./internal.ts";

export interface IPListProps extends ProjectScopedProps {
  /**
   * Name of the list, the API's key for it: 1-51 characters of `[0-9a-z-]`.
   * Changing it replaces the list.
   * @default a physical name generated from the app, stage and logical id
   */
  name?: string;
  /**
   * The IPv4 ranges to deny, in CIDR notation. The list can't be empty, holds at
   * most 50,000 entries, and takes no IPv6. Updated in place.
   */
  cidrs: string[];
  /**
   * User labels, at most 64 including Alchemy's ownership labels (`alchemy.stack`,
   * `alchemy.stage`, `alchemy.id`), which are added automatically. Keys starting
   * with `stackit-` are reserved by STACKIT. Updated in place.
   */
  labels?: Record<string, string>;
}

export interface IPListAttributes {
  /** Name of the list, which an ALB takes as `options.accessControl.ipBlockListName`. */
  listName: string;
  /** Project of the list. */
  projectId: string;
  /** Region of the list. */
  region: string;
  /** STACKIT's fingerprint of the stored content. The CIDRs themselves are never returned. */
  contentHash: string | undefined;
  /** How many CIDRs the list holds. */
  numberOfIps: number | undefined;
  /** The load balancers using it when last read. */
  usage: ipLists.IPListUsage | undefined;
  /** User labels (Alchemy's ownership labels stripped). */
  labels: Record<string, string>;
}

export type IPList = Resource<
  "Stackit.IPLists.IPList",
  IPListProps,
  IPListAttributes,
  never,
  Providers
>;

/**
 * A STACKIT load balancer IP list: a named list of IPv4 ranges to deny, which an
 * Application Load Balancer references through
 * `options.accessControl.ipBlockListName`. It has no hourly fee. STACKIT's API
 * for it is an alpha, with a default quota of 3 lists per project.
 *
 * Its CIDRs and labels update in place. A new name or scope replaces the list.
 * STACKIT limits uploads to one a minute, so a deploy that changes a list right
 * after the last change waits for its turn. The first deploy also enables the
 * service (`cloud.stackit.loadbalancer`) for the project. STACKIT
 * refuses to delete a list a load balancer still references; a delete retries for
 * about a minute, then fails with the API's `BadRequest`.
 *
 * Ownership is tracked with labels. A list with the same name that lacks them is
 * reported as unowned and only taken over with `--adopt`.
 *
 * See [STACKIT's Application Load Balancer docs](https://docs.stackit.cloud/products/network/load-balancing-and-content-delivery/application-load-balancer/).
 *
 * :::caution[Changing `name`, `projectId` or `region` replaces the List]
 * A new list is created, and the old one is deleted once no load balancer references
 * it. STACKIT refuses to delete a list still in use: a delete retries for about a
 * minute, then fails with the API's `BadRequest`.
 * :::
 *
 * ### Creating a List
 * **Example:** A list of ranges to deny
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const blocked = yield* Stackit.IPLists.IPList("Blocked", {
 *   cidrs: ["198.51.100.0/24", "203.0.113.7/32"],
 * });
 * ```
 *
 * **Example:** An explicit name and labels
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const blocked = yield* Stackit.IPLists.IPList("Blocked", {
 *   name: "edge-blocklist",
 *   cidrs: ["198.51.100.0/24"],
 *   labels: { team: "edge" },
 * });
 * ```
 *
 * ### Using it on a Load Balancer
 * **Example:** Deny the listed ranges
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const blocked = yield* Stackit.IPLists.IPList("Blocked", {
 *   cidrs: ["198.51.100.0/24"],
 * });
 * const network = yield* Stackit.IaaS.Network("Network", {
 *   ipv4: { prefix: "10.0.1.0/24" },
 * });
 * const balancer = yield* Stackit.ALB.LoadBalancer("Web", {
 *   networks: [{ networkId: network.networkId }],
 *   options: {
 *     ephemeralAddress: true,
 *     accessControl: { ipBlockListName: blocked.listName },
 *   },
 *   listeners: [
 *     {
 *       name: "http",
 *       port: 80,
 *       protocol: "PROTOCOL_HTTP",
 *       http: { hosts: [{ host: "app.example.com", rules: [{ targetPool: "web" }] }] },
 *     },
 *   ],
 *   targetPools: [
 *     { name: "web", targetPort: 8080, targets: [{ ip: "10.0.1.10" }] },
 *   ],
 * });
 * ```
 *
 * ### Runtime Operations
 * **Example:** Refresh the list from a threat feed in a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Blocked = Stackit.IPLists.IPList("Blocked", {
 *   cidrs: ["198.51.100.0/24"],
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const uploadIPList = yield* Stackit.IPLists.UploadIPList(yield* Blocked);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const list = yield* uploadIPList({
 *           fileContent: "198.51.100.0/24\n203.0.113.0/24",
 *         });
 *         return yield* HttpServerResponse.json({ entries: list.numberOfIps });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.IPLists.UploadIPListHttp)),
 * ) {}
 * ```
 *
 * ### Replacement Cautions
 * **Example:** Renaming a list a load balancer references
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * // A new name creates the new list first, which counts against the quota of 3
 * // while both exist. The load balancer moves to it through `ipBlockListName`
 * // before the old list is deleted.
 * const blocked = yield* Stackit.IPLists.IPList("Blocked", {
 *   name: "edge-blocklist-v2",
 *   cidrs: ["198.51.100.0/24"],
 * });
 * ```
 *
 * @resource
 * @product STACKIT Load Balancer IP Lists
 * @category IPLists
 */
export const IPList = Resource<IPList>("Stackit.IPLists.IPList");

/** Canonical upload payload: order and duplicates don't change what a list denies. */
const fileContent = (cidrs: ReadonlyArray<string>) => [...new Set(cidrs)].sort().join("\n");

const toAttrs = (scope: ProjectScope, list: ipLists.GetIPListResponse): IPListAttributes => ({
  listName: list.name,
  ...scope,
  contentHash: list.contentHash,
  numberOfIps: list.numberOfIps,
  usage: list.usage,
  labels: stripInternalLabels(withoutSystemLabels(list.labels)),
});

export const IPListProvider = () =>
  Provider.succeed(IPList, {
    stables: ["listName", "projectId", "region"],
    // Nuke ordering: `Stackit.ALB.LoadBalancer` declares a dependency on this type.

    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      const scope = { projectId: env.projectId, region: env.region };
      // The API returns every list at once: there is no pagination.
      const { items } = yield* ipLists.listIPLists(scope);
      return (items ?? [])
        .filter((list) => isAlchemyOwned(list.labels))
        .map((list) => toAttrs(scope, list));
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (output === undefined) return undefined;
      // An explicit name could resolve to the one the old list holds: delete it
      // first. A generated name carries the generation.
      if (hasUnresolvedTrigger<IPListProps>(news, ["name", "projectId", "region"])) {
        return {
          action: "replace",
          deleteFirst: rawProp<IPListProps>(news, "name") !== undefined,
        } as const;
      }
      const resolved = triggerProps<IPListProps>(news);
      const scopeChanged = yield* projectScopeChanged(resolved, output);
      const nameChanged =
        resolved.name !== undefined ? resolved.name !== output.listName : olds?.name !== undefined;
      // A new name or scope can't collide with the old one, so it comes up first.
      if (scopeChanged || nameChanged) return { action: "replace" } as const;
      // Everything else updates in place (engine default: props changed).
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output, previous }) {
      const scope = yield* resolveProjectScope(olds, output);
      const recorded = output?.listName ?? olds?.name;
      let observed: ipLists.GetIPListResponse | undefined;
      if (recorded !== undefined) {
        observed = yield* getIPListOrUndefined(scope, recorded);
      } else if (previous !== undefined) {
        // A replacement looks for its own generated name only: labels can't
        // tell generations apart, and garbage collection deletes the old one.
        const generated = yield* physicalName(id);
        observed = yield* getIPListOrUndefined(scope, generated);
      } else {
        // A crashed create or lost state: find it by its labels.
        const { items } = yield* ipLists.listIPLists(scope);
        for (const candidate of items ?? []) {
          if (yield* hasAlchemyLabels(id, candidate.labels)) {
            observed = candidate;
            break;
          }
        }
      }
      if (observed === undefined) return undefined;
      const attrs = toAttrs(scope, observed);
      // The generation being replaced is ours, but only at its own scope: a name is
      // unique per project and region, so elsewhere it can be someone else's.
      if (
        previous?.listName === attrs.listName &&
        previous.projectId === scope.projectId &&
        previous.region === scope.region
      ) {
        return attrs;
      }
      return (yield* hasAlchemyLabels(id, observed.labels)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const scope = yield* resolveProjectScope(news, output);
      const name = news.name ?? output?.listName ?? (yield* physicalName(id));
      const labels = yield* desiredLabels(id, news.labels);

      yield* ensureServiceEnabled({ ...scope, serviceId: LOAD_BALANCER_SERVICE_ID });

      // 1. Observe. The API never returns the CIDRs, and the input of its hash isn't
      // documented, so the content counts as unchanged only when the declared
      // CIDRs are, and the stored hash is the one the last upload left.
      const observed = yield* getIPListOrUndefined(scope, name);
      if (
        observed !== undefined &&
        olds !== undefined &&
        output?.contentHash === observed.contentHash &&
        sameMembers(olds.cidrs, news.cidrs) &&
        !labelsChanged(withoutSystemLabels(observed.labels), labels)
      ) {
        return toAttrs(scope, observed);
      }

      // 2. Ensure and sync: one create-or-replace call, and the only way to change
      // labels. Identical content is a no-op on the API's side. It accepts one
      // upload a minute, so a 429 waits for the next window; the same status means
      // the list quota is reached, which fails once these attempts run out.
      const uploaded = yield* ipLists
        .uploadIPList({
          ...scope,
          name,
          fileContent: fileContent(news.cidrs),
          labels: { ...systemLabels(observed?.labels), ...labels },
        })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "TooManyRequests",
            schedule: Schedule.spaced("15 seconds"),
            times: 6,
          }),
        );

      // 3. Return
      return toAttrs(scope, uploaded);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* retryWhileInUse(
        ipLists.deleteIPList({
          projectId: output.projectId,
          region: output.region,
          name: output.listName,
        }),
      ).pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
