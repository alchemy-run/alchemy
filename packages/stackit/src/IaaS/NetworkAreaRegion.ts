import * as iaas from "@distilled.cloud/stackit/iaas";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { StackitEnvironment } from "../Environment.ts";
import { hasUnresolvedTrigger, triggerProps } from "../internal/diff.ts";
import { sameMembers } from "../internal/equal.ts";
import { waitFor, waitUntilGone } from "../internal/wait.ts";
import { isAlchemyOwned } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  conflictRetry,
  desiredOrganizationId,
  listOrganizationId,
  ownedOnly,
  resolveOrganizationId,
} from "./internal.ts";

export interface NetworkAreaRegionProps {
  /** Network area to configure. Changing it replaces the configuration. */
  networkAreaId: string;
  /**
   * Organization that owns the network area. Defaults to the profile's
   * organization. Changing it replaces the configuration.
   */
  organizationId?: string;
  /**
   * Region to configure the network area in. Defaults to the profile's
   * region. Changing it replaces the configuration.
   */
  region?: string;
  /**
   * IPv4 ranges (CIDR) networks of member projects are allocated from.
   * Ranges are added and removed in place; STACKIT refuses to remove a
   * range that networks still use.
   */
  networkRanges: string[];
  /**
   * IPv4 transfer network (CIDR) the area uses to route between projects.
   * Cannot be updated: changing it deletes the configuration and creates it
   * again, which fails while projects use the area in this region.
   */
  transferNetwork: string;
  /** Default nameservers of new networks in the area. Updated in place. */
  defaultNameservers?: string[];
  /**
   * Prefix length of a network created without an explicit prefix.
   * Updated in place.
   * @default 25
   */
  defaultPrefixLength?: number;
  /**
   * Smallest prefix length (largest network) allowed in the area. Updated
   * in place.
   * @default 24
   */
  minPrefixLength?: number;
  /**
   * Largest prefix length (smallest network) allowed in the area. Updated
   * in place.
   * @default 29
   */
  maxPrefixLength?: number;
}

/** A network range of a regional network area configuration. */
export interface NetworkAreaRange {
  /** Range id. */
  networkRangeId: string;
  /** IPv4 CIDR of the range. */
  prefix: string;
}

export interface NetworkAreaRegionAttributes {
  /** Organization that owns the network area. */
  organizationId: string;
  /** Network area the configuration belongs to. */
  networkAreaId: string;
  /** Configured region. */
  region: string;
  /** Network ranges of the area in this region. */
  networkRanges: NetworkAreaRange[];
  /** Transfer network (CIDR). */
  transferNetwork: string;
  /** Default nameservers of new networks. */
  defaultNameservers: string[];
  /** Default prefix length of new networks. */
  defaultPrefixLength: number;
  /** Smallest allowed prefix length. */
  minPrefixLength: number;
  /** Largest allowed prefix length. */
  maxPrefixLength: number;
  /** Configuration status, `CREATED` once ready. */
  status: string | undefined;
}

export type NetworkAreaRegion = Resource<
  "Stackit.IaaS.NetworkAreaRegion",
  NetworkAreaRegionProps,
  NetworkAreaRegionAttributes,
  never,
  Providers
>;

/**
 * The regional configuration of a STACKIT {@link NetworkArea}: the IPv4
 * address plan (network ranges, transfer network, prefix length limits and
 * default nameservers) the area uses in one region. A network area has at
 * most one configuration per region; member projects can create networks
 * in a region only once it is configured.
 *
 * Network ranges are synced in place through the network range API, and
 * the nameservers and prefix lengths are updated in place. The transfer
 * network cannot change.
 *
 * Ownership: regional configurations carry no labels. The configuration
 * is treated as Alchemy's when its network area carries Alchemy ownership
 * labels; a configuration of a foreign area requires `--adopt`.
 *
 * See [STACKIT's Network Area docs](https://docs.stackit.cloud/products/network/core-networking/network-area/).
 *
 * :::caution[Changing `networkAreaId`, `organizationId`, `region` or `transferNetwork` replaces the Configuration]
 * Changing `transferNetwork` deletes the configuration before creating it again (one
 * configuration per region), which STACKIT refuses while member projects have networks
 * in the region. Changing `networkAreaId`, `organizationId` or `region` configures the
 * new target first.
 * :::
 *
 * ### Configuring a region
 * **Example:** Address plan for the profile's region
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const area = yield* Stackit.IaaS.NetworkArea("Corp", {});
 * const regional = yield* Stackit.IaaS.NetworkAreaRegion("CorpRegion", {
 *   networkAreaId: area.networkAreaId,
 *   networkRanges: ["10.100.0.0/16"],
 *   transferNetwork: "10.255.255.0/24",
 * });
 * ```
 *
 * **Example:** Custom prefix lengths and nameservers
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const area = yield* Stackit.IaaS.NetworkArea("Corp", {});
 * yield* Stackit.IaaS.NetworkAreaRegion("CorpRegion", {
 *   networkAreaId: area.networkAreaId,
 *   region: "eu01",
 *   networkRanges: ["10.100.0.0/16", "10.101.0.0/16"],
 *   transferNetwork: "10.255.255.0/24",
 *   defaultNameservers: ["1.1.1.1"],
 *   defaultPrefixLength: 26,
 *   minPrefixLength: 22,
 *   maxPrefixLength: 28,
 * });
 * ```
 *
 * @resource
 * @product STACKIT Network Area
 * @category IaaS
 */
export const NetworkAreaRegion = Resource<NetworkAreaRegion>("Stackit.IaaS.NetworkAreaRegion");

const DEFAULT_PREFIX_LENGTH = 25;
const MIN_PREFIX_LENGTH = 24;
const MAX_PREFIX_LENGTH = 29;
const READY_TIMEOUT = "5 minutes";

const toAttrs = (
  regional: iaas.RegionalArea,
  scope: { organizationId: string; networkAreaId: string; region: string },
): NetworkAreaRegionAttributes => ({
  ...scope,
  networkRanges: (regional.ipv4?.networkRanges ?? []).map((range) => ({
    networkRangeId: range.id ?? "",
    prefix: range.prefix,
  })),
  transferNetwork: regional.ipv4?.transferNetwork ?? "",
  defaultNameservers: [...(regional.ipv4?.defaultNameservers ?? [])],
  defaultPrefixLength: regional.ipv4?.defaultPrefixLen ?? DEFAULT_PREFIX_LENGTH,
  minPrefixLength: regional.ipv4?.minPrefixLen ?? MIN_PREFIX_LENGTH,
  maxPrefixLength: regional.ipv4?.maxPrefixLen ?? MAX_PREFIX_LENGTH,
  status: regional.status,
});

const getRegional = (scope: { organizationId: string; networkAreaId: string; region: string }) =>
  iaas
    .getNetworkAreaRegion({
      organizationId: scope.organizationId,
      areaId: scope.networkAreaId,
      region: scope.region,
    })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const isReady = (regional: iaas.RegionalArea) =>
  regional.status === undefined || regional.status === "CREATED";
const hasFailed = (regional: iaas.RegionalArea) =>
  regional.status === "ERROR" || regional.status === "FAILED" ? regional.status : undefined;

/** Whether the network area carries Alchemy ownership labels. */
const areaOwned = (organizationId: string, areaId: string) =>
  iaas.getNetworkArea({ organizationId, areaId }).pipe(
    Effect.map((area) => isAlchemyOwned(area.labels)),
    Effect.catchTag("NotFound", () => Effect.succeed(false)),
  );

const resolveScope = Effect.fn(function* (
  news: NetworkAreaRegionProps | undefined,
  output: NetworkAreaRegionAttributes | undefined,
) {
  const organizationId = yield* resolveOrganizationId(news, output);
  const env = yield* StackitEnvironment.current;
  return {
    organizationId,
    networkAreaId: news?.networkAreaId ?? output?.networkAreaId ?? "",
    region: news?.region ?? output?.region ?? env.region,
  };
});

export const NetworkAreaRegionProvider = () =>
  Provider.succeed(NetworkAreaRegion, {
    stables: ["organizationId", "networkAreaId", "region", "transferNetwork"],
    nuke: { dependsOn: ["Stackit.IaaS.NetworkArea"] },

    list: Effect.fn(function* () {
      const organizationId = yield* listOrganizationId;
      if (organizationId === undefined) return [];
      const { items } = yield* iaas.listNetworkAreas({ organizationId });
      const attrs: NetworkAreaRegionAttributes[] = [];
      for (const area of ownedOnly(items)) {
        if (area.id === undefined) continue;
        const { regions } = yield* iaas.listNetworkAreaRegions({
          organizationId,
          areaId: area.id,
        });
        for (const [region, regional] of Object.entries(regions)) {
          if (regional === undefined) continue;
          attrs.push(toAttrs(regional, { organizationId, networkAreaId: area.id, region }));
        }
      }
      return attrs;
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      // One configuration per area and region: delete-first, since an
      // unresolved prop can resolve to the configuration that exists.
      if (
        hasUnresolvedTrigger<NetworkAreaRegionProps>(news, [
          "organizationId",
          "networkAreaId",
          "region",
          "transferNetwork",
        ])
      ) {
        return { action: "replace", deleteFirst: true } as const;
      }
      const resolved = triggerProps<NetworkAreaRegionProps>(news);
      const env = yield* StackitEnvironment.current;
      const organizationId = yield* desiredOrganizationId(resolved);
      if (
        (organizationId !== undefined && organizationId !== output.organizationId) ||
        resolved.networkAreaId !== output.networkAreaId ||
        (resolved.region ?? env.region) !== output.region
      ) {
        return { action: "replace" } as const;
      }
      if (resolved.transferNetwork !== output.transferNetwork) {
        // One configuration per area and region: the old one must go first.
        return { action: "replace", deleteFirst: true } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output, previous }) {
      if (olds === undefined && output === undefined) return undefined;
      const scope = yield* resolveScope(olds, output);
      if (scope.networkAreaId === "") return undefined;
      const observed = yield* getRegional(scope);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(observed, scope);
      // The generation being replaced is ours, whoever owns the area.
      if (
        previous?.organizationId === scope.organizationId &&
        previous.networkAreaId === scope.networkAreaId &&
        previous.region === scope.region
      ) {
        return attrs;
      }
      return (yield* areaOwned(scope.organizationId, scope.networkAreaId)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const scope = yield* resolveScope(news, output);
      const resource = `STACKIT network area ${scope.networkAreaId} in ${scope.region}`;
      const areaRequest = {
        organizationId: scope.organizationId,
        areaId: scope.networkAreaId,
        region: scope.region,
      };
      const defaultPrefixLen = news.defaultPrefixLength ?? DEFAULT_PREFIX_LENGTH;
      const minPrefixLen = news.minPrefixLength ?? MIN_PREFIX_LENGTH;
      const maxPrefixLen = news.maxPrefixLength ?? MAX_PREFIX_LENGTH;
      const read = iaas.getNetworkAreaRegion(areaRequest);
      const waitReady = waitFor({
        resource,
        read,
        ready: isReady,
        failed: hasFailed,
        state: (r) => r.status,
        timeout: READY_TIMEOUT,
      });

      // Observe.
      let current = yield* getRegional(scope);

      // Ensure — configure the region when missing. `Conflict` means a
      // concurrent configure won; pick it up.
      if (current === undefined) {
        current = yield* iaas
          .createNetworkAreaRegion({
            ...areaRequest,
            ipv4: {
              networkRanges: news.networkRanges.map((prefix) => ({ prefix })),
              transferNetwork: news.transferNetwork,
              defaultNameservers: news.defaultNameservers,
              defaultPrefixLen,
              minPrefixLen,
              maxPrefixLen,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => read));
      }
      if (!isReady(current)) current = yield* waitReady;

      // Sync — prefix lengths and nameservers.
      const ipv4 = current.ipv4;
      const update: iaas.UpdateRegionalAreaIPv4 = {};
      if (ipv4?.defaultPrefixLen !== defaultPrefixLen) update.defaultPrefixLen = defaultPrefixLen;
      if (ipv4?.minPrefixLen !== minPrefixLen) update.minPrefixLen = minPrefixLen;
      if (ipv4?.maxPrefixLen !== maxPrefixLen) update.maxPrefixLen = maxPrefixLen;
      if (
        news.defaultNameservers !== undefined &&
        !sameMembers(news.defaultNameservers, ipv4?.defaultNameservers)
      ) {
        update.defaultNameservers = news.defaultNameservers;
      }
      if (Object.keys(update).length > 0) {
        yield* iaas
          .updateNetworkAreaRegion({ ...areaRequest, ipv4: update })
          .pipe(Effect.retry(conflictRetry));
      }

      // Sync — network ranges, against the observed range list. Add first so
      // the area never runs without ranges.
      const { items: observedRanges } = yield* iaas.listNetworkAreaRanges(areaRequest);
      const observedPrefixes = new Set(observedRanges.map((range) => range.prefix));
      const missing = news.networkRanges.filter((prefix) => !observedPrefixes.has(prefix));
      if (missing.length > 0) {
        yield* iaas
          .createNetworkAreaRange({
            ...areaRequest,
            ipv4: missing.map((prefix) => ({ prefix })),
          })
          .pipe(Effect.retry(conflictRetry));
      }
      const desiredPrefixes = new Set(news.networkRanges);
      for (const range of observedRanges) {
        if (desiredPrefixes.has(range.prefix) || range.id === undefined) continue;
        yield* iaas.deleteNetworkAreaRange({ ...areaRequest, networkRangeId: range.id }).pipe(
          Effect.retry(conflictRetry),
          Effect.catchTag("NotFound", () => Effect.void),
        );
      }

      const final = yield* waitFor({
        resource,
        read,
        ready: (r) =>
          isReady(r) &&
          sameMembers(
            (r.ipv4?.networkRanges ?? []).map((range) => range.prefix),
            news.networkRanges,
          ),
        failed: hasFailed,
        state: (r) => r.status,
        timeout: READY_TIMEOUT,
      });
      return toAttrs(final, scope);
    }),

    delete: Effect.fn(function* ({ output }) {
      const scope = {
        organizationId: output.organizationId,
        networkAreaId: output.networkAreaId,
        region: output.region,
      };
      yield* iaas
        .deleteNetworkAreaRegion({
          organizationId: scope.organizationId,
          areaId: scope.networkAreaId,
          region: scope.region,
        })
        .pipe(
          Effect.retry(conflictRetry),
          Effect.catchTag("NotFound", () => Effect.void),
        );
      yield* waitUntilGone({
        resource: `STACKIT network area ${scope.networkAreaId} in ${scope.region}`,
        read: getRegional(scope),
        state: (r) => r.status,
        timeout: READY_TIMEOUT,
      });
    }),
  });
