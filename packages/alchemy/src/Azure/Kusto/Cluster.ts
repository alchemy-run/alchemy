import * as kusto from "@distilled.cloud/azure/azure_kusto";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  requireSinglePage,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { getCluster, lower, whileClusterBusy } from "./common.ts";

export type KustoSkuName = kusto.AzureSkuName;
export type KustoSkuTier = kusto.AzureSkuTier;
export type KustoIdentityType = kusto.IdentityType;
export type KustoLanguageExtensionName = kusto.LanguageExtensionName;
export type KustoLanguageExtensionImageName = kusto.LanguageExtensionImageName;

export interface KustoClusterSku {
  /**
   * SKU name. `Dev(No SLA)_Standard_E2a_v4` is the cheapest (single
   * instance, no SLA).
   * @default "Dev(No SLA)_Standard_E2a_v4"
   */
  name: KustoSkuName;
  /**
   * SKU tier: `Basic` for `Dev(No SLA)_*` SKUs, else `Standard`.
   * @default derived from `name`
   */
  tier?: KustoSkuTier;
  /**
   * Number of instances. Dev SKUs are fixed at 1; Standard SKUs need at
   * least 2.
   * @default Azure's default for the SKU
   */
  capacity?: number;
}

export interface KustoOptimizedAutoscale {
  /** Version of the autoscale template (currently `1`). */
  version: number;
  /** Whether optimized autoscale is enabled. */
  isEnabled: boolean;
  /** Minimum number of instances. */
  minimum: number;
  /** Maximum number of instances. */
  maximum: number;
}

export interface KustoLanguageExtension {
  /** Language extension (`PYTHON` or `R`). */
  name: KustoLanguageExtensionName;
  /**
   * Image of the language extension, e.g. `Python3_11_7` or `R`.
   */
  imageName: KustoLanguageExtensionImageName;
}

export interface KustoKeyVaultProperties {
  /** Name of the key-vault key used for customer-managed key encryption. */
  keyName?: string;
  /** Version of the key; omit to always use the latest version. */
  keyVersion?: string;
  /** URI of the key vault, e.g. `https://myvault.vault.azure.net/`. */
  keyVaultUri?: string;
  /** Resource ID of the user-assigned identity used to access the key. */
  userIdentity?: string;
}

export interface ClusterProps {
  /** Resource group the cluster is created in. Changing it replaces the cluster. */
  resourceGroup: string;
  /**
   * Globally unique cluster name: 4-22 lowercase letters and digits,
   * starting with a letter. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the cluster.
   */
  name?: string;
  /**
   * Azure location of the cluster. Changing it replaces the cluster.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Cluster SKU. Scaling up/down within compatible families is applied in
   * place.
   * @default { name: "Dev(No SLA)_Standard_E2a_v4", tier: "Basic" }
   */
  sku?: KustoClusterSku;
  /**
   * Availability zones. Changing them replaces the cluster.
   */
  zones?: string[];
  /**
   * Managed identity type of the cluster.
   * @default Azure's default (no identity)
   */
  identityType?: KustoIdentityType;
  /**
   * Resource IDs of user-assigned identities attached to the cluster
   * (requires an `identityType` that includes `UserAssigned`).
   */
  userAssignedIdentities?: string[];
  /**
   * Tenant IDs from which principals may be granted access (`*` allows all
   * tenants).
   */
  trustedExternalTenants?: string[];
  /** Optimized autoscale settings (not supported on Dev SKUs). */
  optimizedAutoscale?: KustoOptimizedAutoscale;
  /** Encrypt the cluster's disks. */
  enableDiskEncryption?: boolean;
  /** Enable streaming ingestion. */
  enableStreamingIngest?: boolean;
  /** Allow `.purge` commands on the cluster. */
  enablePurge?: boolean;
  /**
   * Enable infrastructure (double) encryption. Create-time only: changing
   * it replaces the cluster.
   */
  enableDoubleEncryption?: boolean;
  /** Customer-managed key encryption settings. */
  keyVaultProperties?: KustoKeyVaultProperties;
  /**
   * Language extensions (Python, R) enabled on the cluster. Applied via the
   * add/remove language-extension actions; when set, extensions not listed
   * are removed.
   */
  languageExtensions?: KustoLanguageExtension[];
  /**
   * Whether the public endpoint accepts traffic.
   * @default Azure's default (`Enabled`)
   */
  publicNetworkAccess?: "Enabled" | "Disabled";
  /** IP ranges (CIDR) allowed to reach the public endpoint. */
  allowedIpRangeList?: string[];
  /** Engine version (`V2` → `V3` only). */
  engineType?: "V2" | "V3";
  /** Audiences (application IDs) accepted when authenticating. */
  acceptedAudiences?: string[];
  /**
   * Stop the cluster automatically after a long idle period.
   * @default Azure's default (`true`)
   */
  enableAutoStop?: boolean;
  /** Restrict outbound network access from the cluster. */
  restrictOutboundNetworkAccess?: "Enabled" | "Disabled";
  /** FQDNs the cluster may reach when outbound access is restricted. */
  allowedFqdnList?: string[];
  /** Public IP type of the cluster endpoints. */
  publicIPType?: "IPv4" | "DualStack";
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Cluster extends Resource<
  "Azure.Kusto.Cluster",
  ClusterProps,
  {
    /** Name of the cluster. */
    clusterName: string;
    /** ARM resource ID of the cluster. */
    clusterId: string;
    /** Resource group that holds the cluster. */
    resourceGroup: string;
    /** Location of the cluster. */
    location: string;
    /** Query endpoint, e.g. `https://{name}.{region}.kusto.windows.net`. */
    uri: string;
    /** Ingestion endpoint, e.g. `https://ingest-{name}.{region}.kusto.windows.net`. */
    dataIngestionUri: string;
    /** Cluster state, e.g. `Running` or `Stopped`. */
    state: string;
    /** SKU name. */
    skuName: string;
    /** SKU tier. */
    skuTier: string;
    /** Number of instances. */
    capacity: number | undefined;
    /** Principal ID of the system-assigned identity, if any. */
    principalId: string | undefined;
    /** Tenant ID of the system-assigned identity, if any. */
    tenantId: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Data Explorer (Kusto) cluster — the compute and storage that
 * hosts Kusto databases. Defaults to the cheapest Dev SKU
 * (`Dev(No SLA)_Standard_E2a_v4`, one instance, no SLA). Creating a
 * cluster takes 10-20 minutes.
 *
 * @see https://learn.microsoft.com/azure/data-explorer/data-explorer-overview
 *
 * ### Creating a Cluster
 * **Example:** Dev cluster
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("analytics");
 * const cluster = yield* Azure.Kusto.Cluster("adx", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * ```
 *
 * **Example:** Production cluster with streaming ingestion
 * ```typescript
 * const cluster = yield* Azure.Kusto.Cluster("adx", {
 *   resourceGroup: group.resourceGroupName,
 *   sku: { name: "Standard_E2ads_v5", tier: "Standard", capacity: 2 },
 *   enableStreamingIngest: true,
 *   identityType: "SystemAssigned",
 * });
 * ```
 *
 * ### Language Extensions
 * **Example:** Enable the Python plugin
 * ```typescript
 * const cluster = yield* Azure.Kusto.Cluster("adx", {
 *   resourceGroup: group.resourceGroupName,
 *   languageExtensions: [{ name: "PYTHON", imageName: "Python3_11_7" }],
 * });
 * ```
 *
 * @resource
 */
export const Cluster = Resource<Cluster>("Azure.Kusto.Cluster");

type ObservedCluster = kusto.GetClusterResponse;

const DEFAULT_SKU = "Dev(No SLA)_Standard_E2a_v4";

const createClusterName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({
    id,
    maxLength: 22,
    lowercase: true,
    delimiter: "",
  });
  const clean = name.replace(/[^a-z0-9]/g, "");
  return /^[a-z]/.test(clean) ? clean : `k${clean}`.slice(0, 22);
});

const desiredSku = (sku: KustoClusterSku | undefined): kusto.AzureSku => {
  const name = sku?.name ?? DEFAULT_SKU;
  return {
    name,
    tier: sku?.tier ?? (name.startsWith("Dev(") ? "Basic" : "Standard"),
    capacity: sku?.capacity,
  };
};

const toAttrs = (
  resourceGroup: string,
  name: string,
  cluster: kusto.Cluster | ObservedCluster,
): Cluster["Attributes"] => ({
  clusterName: name,
  clusterId: cluster.id ?? "",
  resourceGroup,
  location: cluster.location,
  uri: cluster.properties?.uri ?? "",
  dataIngestionUri: cluster.properties?.dataIngestionUri ?? "",
  state: cluster.properties?.state ?? "",
  skuName: cluster.sku?.name ?? "",
  skuTier: cluster.sku?.tier ?? "",
  capacity: cluster.sku?.capacity,
  principalId: cluster.identity?.principalId,
  tenantId: cluster.identity?.tenantId,
  tags: userTags(cluster.tags),
});

const TRANSITIONAL_STATES = new Set([
  "Creating",
  "Starting",
  "Updating",
  "Stopping",
]);

/**
 * Ready once ARM reports `Succeeded` and the cluster itself left its
 * transitional state (`Creating`, `Starting`, ...).
 */
const clusterReadiness = (cluster: ObservedCluster) => {
  const provisioning = cluster.properties?.provisioningState;
  if (
    (provisioning === undefined || provisioning === "Succeeded") &&
    TRANSITIONAL_STATES.has(cluster.properties?.state ?? "")
  ) {
    return "Pending";
  }
  return provisioning;
};

const sameList = (
  a: ReadonlyArray<string> | undefined,
  b: ReadonlyArray<string> | undefined,
) =>
  JSON.stringify([...(a ?? [])].map((x) => x.toLowerCase()).sort()) ===
  JSON.stringify([...(b ?? [])].map((x) => x.toLowerCase()).sort());

const extensionKey = (name: string | undefined, image: string | undefined) =>
  `${(name ?? "").toUpperCase()}/${image ?? ""}`;

export const ClusterProvider = () =>
  Provider.succeed(Cluster, {
    stables: ["clusterName", "clusterId", "resourceGroup", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* kusto
        .ListClusters({ subscriptionId })
        .pipe(
          Effect.flatMap((page) => requireSinglePage("ListClusters", page)),
        );
      return (page.value ?? []).flatMap((cluster) => {
        const group = resourceGroupOf(cluster.id);
        return hasAnyAlchemyTag(cluster.tags) &&
          group !== undefined &&
          cluster.name !== undefined
          ? [toAttrs(group, cluster.name, cluster)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (news.name !== undefined && news.name !== output.clusterName) ||
        (news.location !== undefined &&
          lower(news.location) !== lower(output.location)) ||
        (olds !== undefined &&
          (!sameList(news.zones, olds.zones) ||
            (news.enableDoubleEncryption ?? false) !==
              (olds.enableDoubleEncryption ?? false)))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.clusterName ?? olds?.name ?? (yield* createClusterName(id));
      const observed = yield* getCluster(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Kusto");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.clusterName ?? (yield* createClusterName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const sku = desiredSku(news.sku);
      const identity: kusto.IdentityInput | undefined =
        news.identityType === undefined
          ? undefined
          : {
              type: news.identityType,
              userAssignedIdentities: news.userAssignedIdentities
                ? Object.fromEntries(
                    news.userAssignedIdentities.map((uai) => [uai, {}]),
                  )
                : undefined,
            };
      const desired: kusto.ClusterPropertiesInput = {
        trustedExternalTenants: news.trustedExternalTenants?.map((value) => ({
          value,
        })),
        optimizedAutoscale: news.optimizedAutoscale,
        enableDiskEncryption: news.enableDiskEncryption,
        enableStreamingIngest: news.enableStreamingIngest,
        enablePurge: news.enablePurge,
        keyVaultProperties: news.keyVaultProperties,
        publicNetworkAccess: news.publicNetworkAccess,
        allowedIpRangeList: news.allowedIpRangeList,
        engineType: news.engineType,
        acceptedAudiences: news.acceptedAudiences?.map((value) => ({ value })),
        enableAutoStop: news.enableAutoStop,
        restrictOutboundNetworkAccess: news.restrictOutboundNetworkAccess,
        allowedFqdnList: news.allowedFqdnList,
        publicIPType: news.publicIPType,
      };
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        clusterName: name,
      };
      const label = `kusto cluster ${name}`;
      const get = getCluster(subscriptionId, resourceGroup, name);
      // Creation takes 10-20 minutes; updates and starts a few minutes.
      const waitReady = waitForProvisioned(label, get, clusterReadiness, {
        interval: "20 seconds",
        times: 60,
      });

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* kusto
          .ClustersCreateOrUpdate({
            ...where,
            location,
            sku,
            zones: news.zones,
            identity,
            tags,
            properties: {
              ...desired,
              enableDoubleEncryption: news.enableDoubleEncryption,
            },
          })
          .pipe(Effect.retry(whileClusterBusy));
      }
      observed = yield* waitReady;

      // A stopped cluster (e.g. auto-stopped when idle) cannot serve its
      // children; start it.
      if (observed.properties?.state === "Stopped") {
        yield* kusto.StartCluster(where).pipe(Effect.retry(whileClusterBusy));
        observed = yield* waitReady;
      }

      // Sync properties, SKU, identity, and tags against observed state.
      const props = observed.properties ?? {};
      const changed: kusto.ClusterPropertiesInput = {};
      const set = <K extends keyof kusto.ClusterPropertiesInput>(
        key: K,
        value: kusto.ClusterPropertiesInput[K],
      ) => {
        changed[key] = value;
      };
      for (const key of [
        "enableDiskEncryption",
        "enableStreamingIngest",
        "enablePurge",
        "publicNetworkAccess",
        "engineType",
        "enableAutoStop",
        "restrictOutboundNetworkAccess",
        "publicIPType",
      ] as const) {
        const value = desired[key];
        if (value !== undefined && props[key] !== value) set(key, value);
      }
      for (const key of ["allowedIpRangeList", "allowedFqdnList"] as const) {
        const value = desired[key];
        if (value !== undefined && !sameList(props[key], value)) {
          set(key, value);
        }
      }
      if (
        news.trustedExternalTenants !== undefined &&
        !sameList(
          props.trustedExternalTenants?.flatMap((t) => t.value ?? []),
          news.trustedExternalTenants,
        )
      ) {
        set("trustedExternalTenants", desired.trustedExternalTenants);
      }
      if (
        news.acceptedAudiences !== undefined &&
        !sameList(
          props.acceptedAudiences?.flatMap((a) => a.value ?? []),
          news.acceptedAudiences,
        )
      ) {
        set("acceptedAudiences", desired.acceptedAudiences);
      }
      if (
        news.optimizedAutoscale !== undefined &&
        JSON.stringify(props.optimizedAutoscale ?? {}) !==
          JSON.stringify({
            version: news.optimizedAutoscale.version,
            isEnabled: news.optimizedAutoscale.isEnabled,
            minimum: news.optimizedAutoscale.minimum,
            maximum: news.optimizedAutoscale.maximum,
          })
      ) {
        set("optimizedAutoscale", news.optimizedAutoscale);
      }
      if (
        news.keyVaultProperties !== undefined &&
        (
          ["keyName", "keyVersion", "keyVaultUri", "userIdentity"] as const
        ).some(
          (key) =>
            news.keyVaultProperties?.[key] !== undefined &&
            news.keyVaultProperties[key] !== props.keyVaultProperties?.[key],
        )
      ) {
        set("keyVaultProperties", news.keyVaultProperties);
      }
      const skuChanged =
        observed.sku?.name !== sku.name ||
        observed.sku?.tier !== sku.tier ||
        (sku.capacity !== undefined && observed.sku?.capacity !== sku.capacity);
      const identityChanged =
        identity !== undefined &&
        (observed.identity?.type !== identity.type ||
          !sameList(
            Object.keys(observed.identity?.userAssignedIdentities ?? {}),
            Object.keys(identity.userAssignedIdentities ?? {}),
          ));
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (
        Object.keys(changed).length > 0 ||
        skuChanged ||
        identityChanged ||
        tagsChanged
      ) {
        yield* kusto
          .UpdateCluster({
            ...where,
            sku: skuChanged ? sku : undefined,
            identity: identityChanged ? identity : undefined,
            tags: tagsChanged ? tags : undefined,
            properties: Object.keys(changed).length > 0 ? changed : undefined,
          })
          .pipe(Effect.retry(whileClusterBusy));
        observed = yield* waitReady;
      }

      // Sync language extensions via the add/remove actions.
      if (news.languageExtensions !== undefined) {
        const current = observed.properties?.languageExtensions?.value ?? [];
        const currentKeys = new Set(
          current.map((e) =>
            extensionKey(e.languageExtensionName, e.languageExtensionImageName),
          ),
        );
        const desiredKeys = new Set(
          news.languageExtensions.map((e) => extensionKey(e.name, e.imageName)),
        );
        const toRemove = current.filter(
          (e) =>
            !desiredKeys.has(
              extensionKey(
                e.languageExtensionName,
                e.languageExtensionImageName,
              ),
            ),
        );
        const toAdd = news.languageExtensions.filter(
          (e) => !currentKeys.has(extensionKey(e.name, e.imageName)),
        );
        if (toRemove.length > 0) {
          yield* kusto
            .RemoveClusterLanguageExtensions({
              ...where,
              value: toRemove.map((e) => ({
                languageExtensionName: e.languageExtensionName,
                languageExtensionImageName: e.languageExtensionImageName,
              })),
            })
            .pipe(Effect.retry(whileClusterBusy));
          observed = yield* waitReady;
        }
        if (toAdd.length > 0) {
          yield* kusto
            .AddClusterLanguageExtensions({
              ...where,
              value: toAdd.map((e) => ({
                languageExtensionName: e.name,
                languageExtensionImageName: e.imageName,
              })),
            })
            .pipe(Effect.retry(whileClusterBusy));
          observed = yield* waitReady;
        }
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        kusto
          .DeleteCluster({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            clusterName: output.clusterName,
          })
          .pipe(Effect.retry(whileClusterBusy)),
      );
      // Deletion takes 5-10 minutes.
      yield* waitUntilGone(
        `kusto cluster ${output.clusterName}`,
        getCluster(subscriptionId, output.resourceGroup, output.clusterName),
        { interval: "20 seconds", times: 50 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
