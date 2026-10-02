import * as netapp from "@distilled.cloud/azure/netapp";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  requireSinglePage,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createNetAppName,
  listAllPools,
  LRO_BUDGET,
  matchesObserved,
  type NetAppExportPolicyRule,
  parseNetAppId,
  poolRefs,
  whileBusy,
} from "./Common.ts";

type Toggle = "Disabled" | "Enabled";

/** The external ONTAP cluster volume the cache fronts. */
export interface CacheOriginCluster {
  /** Name of the origin ONTAP cluster. */
  peerClusterName: string;
  /** Intercluster LIF IP addresses of the origin cluster (one per node). */
  peerAddresses: string[];
  /** Name of the origin storage VM (vserver). */
  peerVserverName: string;
  /** Name of the origin volume. */
  peerVolumeName: string;
}

export interface CacheProps {
  /** Resource group of the NetApp account. Changing it replaces the cache. */
  resourceGroup: string;
  /** Name of the NetApp account. Changing it replaces the cache. */
  account: string;
  /** Name of the capacity pool. Changing it replaces the cache. */
  pool: string;
  /**
   * Cache name. If omitted, a unique name is generated from the app, stage,
   * and logical ID. Changing it replaces the cache.
   */
  name?: string;
  /**
   * Export path of the cache (unique per subscription and region). Changing
   * it replaces the cache.
   * @default the cache name
   */
  filePath?: string;
  /** Cache size in bytes (50 GiB to 1 PiB). */
  size: number;
  /** Subnet (delegated to `Microsoft.NetApp/volumes`) for cache mount targets. Changing it replaces the cache. */
  cacheSubnetResourceId: string;
  /** Subnet used for cluster peering with the origin. Changing it replaces the cache. */
  peeringSubnetResourceId: string;
  /** The origin ONTAP cluster volume. Changing it replaces the cache. */
  originClusterInformation: CacheOriginCluster;
  /**
   * Encryption key source. Changing it replaces the cache.
   * @default "Microsoft.NetApp"
   */
  encryptionKeySource?: "Microsoft.NetApp" | "Microsoft.KeyVault";
  /** Private endpoint to the Key Vault for customer-managed keys. */
  keyVaultPrivateEndpointResourceId?: string;
  /** Protocols the cache serves. */
  protocolTypes?: ("NFSv3" | "NFSv4" | "SMB")[];
  /** Export policy rules. */
  exportPolicy?: NetAppExportPolicyRule[];
  /** Throughput in MiB/s (manual-QoS pools). */
  throughputMibps?: number;
  /** SMB share settings. */
  smbSettings?: {
    /** SMB3 encryption of in-flight data. */
    smbEncryption?: Toggle;
    /** Access-based enumeration. */
    smbAccessBasedEnumeration?: Toggle;
    /** Hide the share from browse lists. */
    smbNonBrowsable?: Toggle;
  };
  /** Kerberos. Changing it replaces the cache. */
  kerberos?: Toggle;
  /** LDAP. Changing it replaces the cache. */
  ldap?: Toggle;
  /** LDAP server type. Changing it replaces the cache. */
  ldapServerType?: "ActiveDirectory" | "OpenLDAP";
  /** Global file locking across caches. Changing it replaces the cache. */
  globalFileLocking?: Toggle;
  /** CIFS change notifications. */
  cifsChangeNotifications?: Toggle;
  /** Write-back caching. */
  writeBack?: Toggle;
  /** Availability zone. Changing it replaces the cache. */
  zones?: string[];
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Cache extends Resource<
  "Azure.NetApp.Cache",
  CacheProps,
  {
    /** Name of the cache. */
    cacheName: string;
    /** ARM resource ID of the cache. */
    cacheId: string;
    /** Parent NetApp account. */
    account: string;
    /** Parent capacity pool. */
    pool: string;
    /** Resource group of the account. */
    resourceGroup: string;
    /** Location of the cache. */
    location: string;
    /** Export path. */
    filePath: string;
    /** Size in bytes. */
    size: number;
    /**
     * Lifecycle state, e.g. `ClusterPeeringOfferSent` while the origin
     * cluster has not yet accepted peering, then `Succeeded`.
     */
    cacheState: string | undefined;
    /** Mount target IP addresses. */
    mountIpAddresses: string[];
    /**
     * ONTAP command to run on the origin cluster to accept cluster peering
     * (present while peering is pending).
     */
    clusterPeeringCommand: string | undefined;
    /** Passphrase for the cluster peering command. */
    clusterPeeringPassphrase: Redacted.Redacted<string> | undefined;
    /** ONTAP command to run on the origin cluster to accept vserver peering. */
    vserverPeeringCommand: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure NetApp Files cache volume — a FlexCache that fronts a volume on
 * an external (on-premises or cloud) ONTAP cluster. After creation the
 * cache waits in `ClusterPeeringOfferSent`; run the returned
 * `clusterPeeringCommand` / `vserverPeeringCommand` on the origin cluster
 * to finish peering.
 *
 * @see https://learn.microsoft.com/azure/azure-netapp-files/cache-volumes
 *
 * ### Creating a Cache
 * **Example:** Cache an on-premises ONTAP volume
 * ```typescript
 * const cache = yield* Azure.NetApp.Cache("cache", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   pool: pool.poolName,
 *   size: 100 * Azure.NetApp.GiB,
 *   cacheSubnetResourceId: anfSubnet.subnetId,
 *   peeringSubnetResourceId: peeringSubnet.subnetId,
 *   protocolTypes: ["NFSv3"],
 *   originClusterInformation: {
 *     peerClusterName: "onprem-cluster",
 *     peerAddresses: ["192.168.1.10", "192.168.1.11"],
 *     peerVserverName: "svm1",
 *     peerVolumeName: "data",
 *   },
 * });
 * ```
 *
 * ### Write-back
 * **Example:** Enable write-back caching
 * ```typescript
 * const cache = yield* Azure.NetApp.Cache("cache", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   pool: pool.poolName,
 *   size: 100 * Azure.NetApp.GiB,
 *   cacheSubnetResourceId: anfSubnet.subnetId,
 *   peeringSubnetResourceId: peeringSubnet.subnetId,
 *   originClusterInformation: origin,
 *   writeBack: "Enabled",
 * });
 * ```
 *
 * @resource
 */
export const Cache = Resource<Cache>("Azure.NetApp.Cache");

interface Where {
  subscriptionId: string;
  resourceGroupName: string;
  accountName: string;
  poolName: string;
  cacheName: string;
}

const getCache = (where: Where) => orUndefinedIfNotFound(netapp.GetCach(where));

const PEERING_PENDING = new Set([
  "ClusterPeeringOfferSent",
  "VserverPeeringOfferSent",
]);

/**
 * Ready once ARM reports `Succeeded`, or once the cache waits for the
 * origin cluster to accept peering (an out-of-band step).
 */
const readiness = (cache: netapp.GetCachResponse) =>
  PEERING_PENDING.has(cache.properties?.cacheState ?? "")
    ? "Succeeded"
    : cache.properties?.provisioningState;

const toAttrs = (
  where: Where,
  cache: netapp.GetCachResponse | netapp.Cache,
  peering?: netapp.PeeringPassphrases,
): Cache["Attributes"] => ({
  cacheName: where.cacheName,
  cacheId: cache.id ?? "",
  account: where.accountName,
  pool: where.poolName,
  resourceGroup: where.resourceGroupName,
  location: cache.location ?? "",
  filePath: cache.properties?.filePath ?? "",
  size: cache.properties?.size ?? 0,
  cacheState: cache.properties?.cacheState,
  mountIpAddresses: (cache.properties?.mountTargets ?? []).flatMap((t) =>
    t.ipAddress ? [t.ipAddress] : [],
  ),
  clusterPeeringCommand: peering?.clusterPeeringCommand,
  clusterPeeringPassphrase: peering
    ? Redacted.make(peering.clusterPeeringPassphrase)
    : undefined,
  vserverPeeringCommand: peering?.vserverPeeringCommand,
  tags: userTags(cache.tags),
});

const sameList = (
  a: ReadonlyArray<string> | undefined,
  b: ReadonlyArray<string> | undefined,
) =>
  JSON.stringify([...(a ?? [])].map((x) => x.toLowerCase()).sort()) ===
  JSON.stringify([...(b ?? [])].map((x) => x.toLowerCase()).sort());

export const CacheProvider = () =>
  Provider.succeed(Cache, {
    stables: [
      "cacheName",
      "cacheId",
      "account",
      "pool",
      "resourceGroup",
      "location",
      "filePath",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const pools = yield* listAllPools(subscriptionId);
      const caches = yield* Effect.forEach(
        poolRefs(pools),
        ({ resourceGroup, account, name }) =>
          orUndefinedIfNotFound(
            netapp
              .ListCaches({
                subscriptionId,
                resourceGroupName: resourceGroup,
                accountName: account,
                poolName: name,
              })
              .pipe(
                Effect.flatMap((page) => requireSinglePage("ListCaches", page)),
              ),
          ).pipe(Effect.map((page) => page?.value ?? [])),
      );
      return caches.flat().flatMap((cache) => {
        const { resourceGroup, account, pool, name } = parseNetAppId(cache.id);
        return hasAnyAlchemyTag(cache.tags) &&
          resourceGroup &&
          account &&
          pool &&
          name
          ? [
              toAttrs(
                {
                  subscriptionId,
                  resourceGroupName: resourceGroup,
                  accountName: account,
                  poolName: pool,
                  cacheName: name,
                },
                cache,
              ),
            ]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const immutableChanged =
        olds !== undefined &&
        (news.cacheSubnetResourceId.toLowerCase() !==
          olds.cacheSubnetResourceId?.toLowerCase() ||
          news.peeringSubnetResourceId.toLowerCase() !==
            olds.peeringSubnetResourceId?.toLowerCase() ||
          !matchesObserved(
            news.originClusterInformation,
            olds.originClusterInformation,
          ) ||
          (news.encryptionKeySource ?? "Microsoft.NetApp") !==
            (olds.encryptionKeySource ?? "Microsoft.NetApp") ||
          news.kerberos !== olds.kerberos ||
          news.ldap !== olds.ldap ||
          news.ldapServerType !== olds.ldapServerType ||
          news.globalFileLocking !== olds.globalFileLocking ||
          !sameList(news.zones, olds.zones));
      if (
        immutableChanged ||
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.account.toLowerCase() !== output.account.toLowerCase() ||
        news.pool.toLowerCase() !== output.pool.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.cacheName.toLowerCase()) ||
        (news.filePath !== undefined && news.filePath !== output.filePath)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroupName = output?.resourceGroup ?? olds?.resourceGroup;
      const accountName = output?.account ?? olds?.account;
      const poolName = output?.pool ?? olds?.pool;
      if (!resourceGroupName || !accountName || !poolName) return undefined;
      const where = {
        subscriptionId,
        resourceGroupName,
        accountName,
        poolName,
        cacheName:
          output?.cacheName ?? olds?.name ?? (yield* createNetAppName(id, 64)),
      };
      const observed = yield* getCache(where);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(where, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.NetApp");
      const where = {
        subscriptionId,
        resourceGroupName: news.resourceGroup,
        accountName: news.account,
        poolName: news.pool,
        cacheName:
          news.name ?? output?.cacheName ?? (yield* createNetAppName(id, 64)),
      };
      const tags = yield* desiredTags(id, news.tags);
      const rules = news.exportPolicy?.map((rule) => ({
        hasRootAccess: true,
        ...rule,
      }));
      const desired = {
        size: news.size,
        protocolTypes: news.protocolTypes,
        throughputMibps: news.throughputMibps,
        smbSettings: news.smbSettings,
        keyVaultPrivateEndpointResourceId:
          news.keyVaultPrivateEndpointResourceId,
        cifsChangeNotifications: news.cifsChangeNotifications,
        writeBack: news.writeBack,
      };
      const get = getCache(where);
      const waitReady = waitForProvisioned(
        `netapp cache ${where.cacheName}`,
        get,
        readiness,
        LRO_BUDGET,
      );

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        const parent = yield* netapp.GetPool({
          subscriptionId,
          resourceGroupName: where.resourceGroupName,
          accountName: where.accountName,
          poolName: where.poolName,
        });
        yield* whileBusy(
          netapp.CachesCreateOrUpdate({
            ...where,
            location: parent.location,
            tags,
            zones: news.zones,
            properties: {
              ...desired,
              filePath: news.filePath ?? where.cacheName,
              cacheSubnetResourceId: news.cacheSubnetResourceId,
              peeringSubnetResourceId: news.peeringSubnetResourceId,
              originClusterInformation: news.originClusterInformation,
              encryptionKeySource:
                news.encryptionKeySource ?? "Microsoft.NetApp",
              exportPolicy: rules ? { rules } : undefined,
              kerberos: news.kerberos,
              ldap: news.ldap,
              ldapServerType: news.ldapServerType,
              globalFileLocking: news.globalFileLocking,
            },
          }),
        );
      }
      observed = yield* waitReady;

      // Sync mutable properties, export policy, and tags against observed
      // state; PATCH only the delta.
      const props = observed.properties;
      const changed: netapp.CacheUpdateProperties = {};
      for (const key of Object.keys(desired) as (keyof typeof desired)[]) {
        const value = desired[key];
        if (value !== undefined && !matchesObserved(value, props?.[key])) {
          Object.assign(changed, { [key]: value });
        }
      }
      if (rules && !matchesObserved(rules, props?.exportPolicy?.rules ?? [])) {
        changed.exportPolicy = { rules };
      }
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (Object.keys(changed).length > 0 || tagsChanged) {
        yield* whileBusy(
          netapp.UpdateCach({
            ...where,
            tags: tagsChanged ? tags : undefined,
            properties: Object.keys(changed).length > 0 ? changed : undefined,
          }),
        );
        observed = yield* waitReady;
      }

      const peering = PEERING_PENDING.has(observed.properties?.cacheState ?? "")
        ? yield* netapp.ListCachPeeringPassphrases(where)
        : undefined;
      return toAttrs(where, observed, peering);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const where = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        accountName: output.account,
        poolName: output.pool,
        cacheName: output.cacheName,
      };
      yield* whileBusy(ignoreNotFound(netapp.DeleteCach(where)));
      yield* waitUntilGone(
        `netapp cache ${output.cacheName}`,
        getCache(where),
        LRO_BUDGET,
      );
    }),

    nuke: {
      dependsOn: ["Azure.NetApp.CapacityPool", "Azure.Resources.ResourceGroup"],
    },
  });
