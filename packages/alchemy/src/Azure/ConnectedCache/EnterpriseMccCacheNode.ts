import * as connectedcache from "@distilled.cloud/azure/connectedcache";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  stackAndStage,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { createConnectedCacheName, MCC_BUDGET, sameArm } from "./Common.ts";

/** A cache drive on the server that hosts the cache node. */
export interface EnterpriseMccCacheNodeDrive {
  /** Absolute path of the folder used for cached content, e.g. `/var/mcc`. */
  physicalPath: string;
  /** Size of the cache drive in GB (at least 50). */
  sizeInGb: number;
  /** Cache number (1-9) of the drive, unique within the node. */
  cacheNumber: number;
}

export interface EnterpriseMccCacheNodeProps {
  /**
   * Resource group that holds the parent customer. Changing it replaces the
   * cache node.
   */
  resourceGroup: string;
  /**
   * Name of the parent `Azure.ConnectedCache.EnterpriseMccCustomer`.
   * Changing it replaces the cache node.
   */
  customer: string;
  /**
   * Cache node resource name. If omitted, a unique name is generated from
   * the app, stage, and logical ID. Changing it replaces the cache node.
   */
  name?: string;
  /**
   * Azure location of the cache node; must match the customer's location.
   * Changing it replaces the cache node.
   * @default the parent customer's location
   */
  location?: string;
  /**
   * Display name of the cache node in the Connected Cache portal.
   * @default the resource name
   */
  cacheNodeName?: string;
  /**
   * Operating system of the server that hosts the cache node. Changing it
   * replaces the cache node.
   * @default "Linux"
   */
  osType?: "Linux" | "Windows" | "Eflow";
  /**
   * Cache drives on the host server (one to nine).
   * @default [{ physicalPath: "/var/mcc", sizeInGb: 100, cacheNumber: 1 }]
   */
  driveConfiguration?: EnterpriseMccCacheNodeDrive[];
  /** Maximum egress the cache node may serve, in Mbps. */
  maxAllowableEgressInMbps?: number;
  /**
   * Whether the cache node is enabled.
   * @default false
   */
  isEnabled?: boolean;
  /**
   * HTTP proxy the cache node uses to reach the internet, as
   * `host:port` or `http://host:port`. Omit when no proxy is required.
   */
  proxyUrl?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface EnterpriseMccCacheNode extends Resource<
  "Azure.ConnectedCache.EnterpriseMccCacheNode",
  EnterpriseMccCacheNodeProps,
  {
    /** Name of the cache node resource. */
    cacheNodeResourceName: string;
    /** ARM resource ID of the cache node. */
    cacheNodeResourceId: string;
    /** Name of the parent customer resource. */
    customer: string;
    /** Resource group that holds the cache node. */
    resourceGroup: string;
    /** Location of the cache node. */
    location: string;
    /** GUID the Connected Cache service assigns to the cache node. */
    cacheNodeId: string | undefined;
    /** GUID of the parent customer in the Connected Cache service. */
    customerId: string | undefined;
    /** Display name of the cache node. */
    cacheNodeName: string | undefined;
    /** Operating system of the host server. */
    osType: string | undefined;
    /** Cache drives on the host server. */
    driveConfiguration: EnterpriseMccCacheNodeDrive[];
    /** Maximum egress the cache node may serve, in Mbps. */
    maxAllowableEgressInMbps: number | undefined;
    /** Whether the cache node is enabled. */
    isEnabled: boolean | undefined;
    /** HTTP proxy the cache node uses, if any. */
    proxyUrl: string | undefined;
    /**
     * Whether a server has run the provisioning script for this node. Stays
     * `false` until the cache software is installed on real hardware.
     */
    isProvisioned: boolean | undefined;
    /** ARM provisioning state of the cache node. */
    provisioningState: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A Microsoft Connected Cache for Enterprise and Education cache node — the
 * ARM record of one customer-hosted server that caches Microsoft content.
 *
 * Creating the node registers its configuration (OS, cache drives, egress
 * limit, proxy); the node becomes active once the provisioning script from
 * the Azure portal is run on the host server, which is outside Alchemy.
 *
 * The resource provider stores tags but does not return them from GET, so
 * the node's tags are written on every reconcile and ownership is derived
 * from the parent customer's Alchemy tags.
 *
 * @see https://learn.microsoft.com/windows/deployment/do/mcc-ent-create-resource-and-cache
 *
 * ### Creating a Cache Node
 * **Example:** Linux cache node with one cache drive
 * ```typescript
 * const customer = yield* Azure.ConnectedCache.EnterpriseMccCustomer("mcc", {
 *   resourceGroup: group.resourceGroupName,
 *   location: "westus",
 * });
 * const node = yield* Azure.ConnectedCache.EnterpriseMccCacheNode("node", {
 *   resourceGroup: group.resourceGroupName,
 *   customer: customer.customerResourceName,
 *   osType: "Linux",
 *   driveConfiguration: [
 *     { physicalPath: "/var/mcc", sizeInGb: 100, cacheNumber: 1 },
 *   ],
 * });
 * ```
 *
 * ### Limiting Egress Behind a Proxy
 * **Example:** Enabled node with an egress cap and an HTTP proxy
 * ```typescript
 * yield* Azure.ConnectedCache.EnterpriseMccCacheNode("branch", {
 *   resourceGroup: group.resourceGroupName,
 *   customer: customer.customerResourceName,
 *   isEnabled: true,
 *   maxAllowableEgressInMbps: 500,
 *   proxyUrl: "http://proxy.contoso.com:8080",
 * });
 * ```
 *
 * @resource
 */
export const EnterpriseMccCacheNode = Resource<EnterpriseMccCacheNode>(
  "Azure.ConnectedCache.EnterpriseMccCacheNode",
);

type ObservedNode =
  | connectedcache.GetEnterpriseMccCacheNodesOperationResponse
  | connectedcache.EnterpriseMccCacheNodesOperationsCreateOrUpdateResponse
  | connectedcache.UpdateEnterpriseMccCacheNodesOperationResponse;

const DEFAULT_DRIVES: EnterpriseMccCacheNodeDrive[] = [
  { physicalPath: "/var/mcc", sizeInGb: 100, cacheNumber: 1 },
];

const getNode = (
  subscriptionId: string,
  resourceGroupName: string,
  customerResourceName: string,
  cacheNodeResourceName: string,
) =>
  orUndefinedIfNotFound(
    connectedcache.GetEnterpriseMccCacheNodesOperation({
      subscriptionId,
      resourceGroupName,
      customerResourceName,
      cacheNodeResourceName,
    }),
  );

const drivesOf = (node: ObservedNode): EnterpriseMccCacheNodeDrive[] =>
  (node.properties?.additionalCacheNodeProperties?.driveConfiguration ?? [])
    .map((drive) => ({
      physicalPath: drive.physicalPath ?? "",
      sizeInGb: drive.sizeInGb ?? 0,
      cacheNumber: drive.cacheNumber ?? 0,
    }))
    .sort((a, b) => a.cacheNumber - b.cacheNumber);

const sameDrives = (
  a: ReadonlyArray<EnterpriseMccCacheNodeDrive>,
  b: ReadonlyArray<EnterpriseMccCacheNodeDrive>,
) => {
  const key = (drives: ReadonlyArray<EnterpriseMccCacheNodeDrive>) =>
    JSON.stringify(
      [...drives]
        .sort((x, y) => x.cacheNumber - y.cacheNumber)
        .map((d) => [d.cacheNumber, d.physicalPath, d.sizeInGb]),
    );
  return key(a) === key(b);
};

const proxyOf = (node: ObservedNode) => {
  const url =
    node.properties?.additionalCacheNodeProperties?.proxyUrlConfiguration
      ?.proxyUrl;
  return url === "" ? undefined : url;
};

const toAttrs = (
  resourceGroup: string,
  customer: string,
  name: string,
  node: ObservedNode,
  tags: Record<string, string>,
): EnterpriseMccCacheNode["Attributes"] => ({
  cacheNodeResourceName: name,
  cacheNodeResourceId: node.id ?? "",
  customer,
  resourceGroup,
  location: node.location,
  cacheNodeId: node.properties?.cacheNode?.cacheNodeId,
  customerId: node.properties?.cacheNode?.customerId,
  cacheNodeName: node.properties?.cacheNode?.cacheNodeName,
  osType: node.properties?.additionalCacheNodeProperties?.osType,
  driveConfiguration: drivesOf(node),
  maxAllowableEgressInMbps:
    node.properties?.cacheNode?.maxAllowableEgressInMbps,
  isEnabled: node.properties?.cacheNode?.isEnabled,
  proxyUrl: proxyOf(node),
  isProvisioned: node.properties?.additionalCacheNodeProperties?.isProvisioned,
  provisioningState: node.properties?.provisioningState,
  tags,
});

/**
 * The cache node GET omits tags, so ownership follows the parent customer:
 * a node is ours when its customer carries this stack/stage's tags.
 */
const parentOwned = (
  subscriptionId: string,
  resourceGroupName: string,
  customerResourceName: string,
) =>
  Effect.gen(function* () {
    const customer = yield* orUndefinedIfNotFound(
      connectedcache.GetEnterpriseMccCustomer({
        subscriptionId,
        resourceGroupName,
        customerResourceName,
      }),
    );
    const { stack, stage } = yield* stackAndStage;
    return (
      customer?.tags?.["alchemy::stack"] === stack &&
      customer?.tags?.["alchemy::stage"] === stage
    );
  });

export const EnterpriseMccCacheNodeProvider = () =>
  Provider.succeed(EnterpriseMccCacheNode, {
    stables: [
      "cacheNodeResourceName",
      "cacheNodeResourceId",
      "customer",
      "resourceGroup",
      "location",
      "cacheNodeId",
      "customerId",
    ],

    // Cache nodes vanish with their parent customer.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        !sameArm(news.customer, output.customer) ||
        (news.name !== undefined &&
          !sameArm(news.name, output.cacheNodeResourceName)) ||
        (news.location !== undefined &&
          !sameArm(news.location, output.location)) ||
        (output.osType !== undefined &&
          !sameArm(news.osType ?? "Linux", output.osType))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const customer = output?.customer ?? olds?.customer;
      if (resourceGroup === undefined || customer === undefined) {
        return undefined;
      }
      const name =
        output?.cacheNodeResourceName ??
        olds?.name ??
        (yield* createConnectedCacheName(id));
      const observed = yield* getNode(
        subscriptionId,
        resourceGroup,
        customer,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(
        resourceGroup,
        customer,
        name,
        observed,
        output?.tags ?? {},
      );
      return (yield* parentOwned(subscriptionId, resourceGroup, customer))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.ConnectedCache");
      const resourceGroup = news.resourceGroup;
      const customer = news.customer;
      const name =
        news.name ??
        output?.cacheNodeResourceName ??
        (yield* createConnectedCacheName(id));
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        customerResourceName: customer,
        cacheNodeResourceName: name,
      };
      const get = getNode(subscriptionId, resourceGroup, customer, name);
      const label = `Connected Cache cache node ${name}`;
      const desired = {
        cacheNodeName: news.cacheNodeName ?? name,
        osType: news.osType ?? "Linux",
        drives: news.driveConfiguration ?? DEFAULT_DRIVES,
        maxAllowableEgressInMbps: news.maxAllowableEgressInMbps,
        isEnabled: news.isEnabled ?? false,
        proxyUrl: news.proxyUrl,
      };
      const put = (location: string) =>
        connectedcache.EnterpriseMccCacheNodesOperationsCreateOrUpdate({
          ...where,
          location,
          tags,
          properties: {
            cacheNode: {
              cacheNodeName: desired.cacheNodeName,
              maxAllowableEgressInMbps: desired.maxAllowableEgressInMbps,
              isEnabled: desired.isEnabled,
            },
            additionalCacheNodeProperties: {
              osType: desired.osType,
              driveConfiguration: desired.drives,
              isProxyRequired:
                desired.proxyUrl === undefined ? "None" : "Required",
              proxyUrlConfiguration:
                desired.proxyUrl === undefined
                  ? undefined
                  : { proxyUrl: desired.proxyUrl },
            },
          },
        });
      // Replicas of the RP can briefly serve the pre-PUT body, so a write
      // is settled only once the desired configuration is observed.
      const configDiffers = (node: ObservedNode) =>
        node.properties?.cacheNode?.cacheNodeName !== desired.cacheNodeName ||
        (desired.maxAllowableEgressInMbps !== undefined &&
          node.properties?.cacheNode?.maxAllowableEgressInMbps !==
            desired.maxAllowableEgressInMbps) ||
        (node.properties?.cacheNode?.isEnabled ?? false) !==
          desired.isEnabled ||
        !sameDrives(drivesOf(node), desired.drives) ||
        proxyOf(node) !== desired.proxyUrl;
      const settled = (node: ObservedNode) =>
        configDiffers(node) ? "Updating" : node.properties?.provisioningState;

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        const location =
          news.location ??
          output?.location ??
          (yield* connectedcache.GetEnterpriseMccCustomer({
            subscriptionId,
            resourceGroupName: resourceGroup,
            customerResourceName: customer,
          })).location;
        yield* put(location);
        observed = yield* waitForProvisioned(label, get, settled, MCC_BUDGET);
      } else {
        observed = yield* waitForProvisioned(
          label,
          get,
          (node) => node.properties?.provisioningState,
          MCC_BUDGET,
        );
      }

      // Sync configuration (PUT only) against observed state.
      if (configDiffers(observed)) {
        yield* put(observed.location);
        observed = yield* waitForProvisioned(label, get, settled, MCC_BUDGET);
      }

      // Sync tags. GET never returns the node's tags, so the PATCH is the
      // only observation of them; it is a cheap idempotent write.
      const patched =
        yield* connectedcache.UpdateEnterpriseMccCacheNodesOperation({
          ...where,
          tags,
        });

      return toAttrs(
        resourceGroup,
        customer,
        name,
        observed,
        userTags(patched.tags ?? tags),
      );
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        connectedcache.DeleteEnterpriseMccCacheNodesOperation({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          customerResourceName: output.customer,
          cacheNodeResourceName: output.cacheNodeResourceName,
        }),
      );
      yield* waitUntilGone(
        `Connected Cache cache node ${output.cacheNodeResourceName}`,
        getNode(
          subscriptionId,
          output.resourceGroup,
          output.customer,
          output.cacheNodeResourceName,
        ),
        MCC_BUDGET,
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.ConnectedCache.EnterpriseMccCustomer",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
