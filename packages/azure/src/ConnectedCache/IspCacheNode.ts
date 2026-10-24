import * as connectedcache from "@distilled.cloud/azure/connectedcache";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  desiredTags,
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  stackAndStage,
  userTags,
  waitForProvisioned,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { createConnectedCacheName, deleteUntilGone, MCC_BUDGET, sameArm } from "./Common.ts";

/** A cache drive on the server that hosts the ISP cache node. */
export interface IspCacheNodeDrive {
  /** Absolute path of the folder used for cached content, e.g. `/var/mcc`. */
  physicalPath: string;
  /** Size of the cache drive in GB. */
  sizeInGb: number;
  /** Cache number of the drive (1-20), unique within the node. */
  cacheNumber: number;
}

/** Release ring the cache node's software updates come from. */
export type IspCacheNodeUpdateRing = "Stable" | "Beta";

export interface IspCacheNodeProps {
  /**
   * Resource group that holds the parent customer. Changing it replaces the
   * cache node.
   */
  resourceGroup: string;
  /**
   * Name of the parent `Azure.ConnectedCache.IspCustomer`. Its signup must
   * have completed. Changing it replaces the cache node.
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
  /** IPv4 address of the server that hosts the cache node. */
  ipAddress?: string;
  /**
   * Client IP ranges (CIDR blocks) the cache node serves, when routing is
   * configured manually instead of over BGP.
   */
  cidrCsv?: string[];
  /** Maximum egress the cache node may serve, in Mbps. */
  maxAllowableEgressInMbps?: number;
  /**
   * Whether the cache node is enabled.
   * @default false
   */
  isEnabled?: boolean;
  /**
   * Operating system of the server that hosts the cache node. Changing it
   * replaces the cache node.
   * @default "Linux"
   */
  osType?: "Linux" | "Windows" | "Eflow";
  /**
   * Cache drives on the host server.
   * @default [{ physicalPath: "/var/mcc", sizeInGb: 100, cacheNumber: 1 }]
   */
  driveConfiguration?: IspCacheNodeDrive[];
  /**
   * HTTP proxy the cache node uses to reach the internet, as
   * `host:port` or `http://host:port`. Omit when no proxy is required.
   */
  proxyUrl?: string;
  /**
   * Release ring the cache node's software updates come from.
   * @default the service default (`Stable`)
   */
  autoUpdateRingType?: IspCacheNodeUpdateRing;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface IspCacheNode extends Resource<
  "Azure.ConnectedCache.IspCacheNode",
  IspCacheNodeProps,
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
    /** IPv4 address of the host server. */
    ipAddress: string | undefined;
    /** Client IP ranges the cache node serves. */
    cidrCsv: string[];
    /** Operating system of the host server. */
    osType: string | undefined;
    /** Cache drives on the host server. */
    driveConfiguration: IspCacheNodeDrive[];
    /** Maximum egress the cache node may serve, in Mbps. */
    maxAllowableEgressInMbps: number | undefined;
    /** Whether the cache node is enabled. */
    isEnabled: boolean | undefined;
    /** HTTP proxy the cache node uses, if any. */
    proxyUrl: string | undefined;
    /** Release ring of the cache node's software updates. */
    autoUpdateRingType: string | undefined;
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
 * A Microsoft Connected Cache for ISPs cache node
 * (`Microsoft.ConnectedCache/ispCustomers/ispCacheNodes`) — the ARM record
 * of one ISP-hosted server that caches Microsoft content for the ISP's
 * subscribers.
 *
 * Creating the node registers its configuration (host IP, client CIDR
 * ranges, egress limit, cache drives, proxy). Azure accepts it only after
 * the parent `Azure.ConnectedCache.IspCustomer` has completed signup (ASN
 * verification through PeeringDB); otherwise the create fails with
 * `ConnectedCacheIspSignupIncomplete`. The node becomes active once the
 * provisioning script from the Azure portal runs on the host server, which
 * is outside Alchemy.
 *
 * Ownership is derived from the parent customer's Alchemy tags.
 *
 * @see https://learn.microsoft.com/windows/deployment/do/mcc-isp-create-provision-deploy
 *
 * ### Creating a Cache Node
 * **Example:** Linux cache node serving one client range
 * ```typescript
 * const isp = yield* Azure.ConnectedCache.IspCustomer("isp", {
 *   location: "westus",
 *   asn: "65010",
 * });
 * const node = yield* Azure.ConnectedCache.IspCacheNode("node", {
 *   customer: isp.customerResourceName,
 *   ipAddress: "203.0.113.10",
 *   cidrCsv: ["198.51.100.0/24"],
 *   maxAllowableEgressInMbps: 10000,
 *   driveConfiguration: [
 *     { physicalPath: "/var/mcc", sizeInGb: 500, cacheNumber: 1 },
 *   ],
 * });
 * ```
 *
 * ### Enabling a Node on the Beta Ring
 * **Example:** Enabled node behind an HTTP proxy
 * ```typescript
 * yield* Azure.ConnectedCache.IspCacheNode("edge", {
 *   customer: isp.customerResourceName,
 *   isEnabled: true,
 *   autoUpdateRingType: "Beta",
 *   proxyUrl: "http://proxy.contoso.example:8080",
 * });
 * ```
 *
 * :::caution
 * Changing `name`, `customer`, `location`, `osType`, or `resourceGroup`
 * replaces the cache node; the host server must then be provisioned again.
 * :::
 *
 * @resource
 */
export const IspCacheNode = GroupedResource<IspCacheNode>("Azure.ConnectedCache.IspCacheNode");

type ObservedNode =
  | connectedcache.GetIspCacheNodesOperationResponse
  | connectedcache.IspCacheNodesOperationsCreateOrUpdateResponse
  | connectedcache.UpdateIspCacheNodesOperationResponse;

const DEFAULT_DRIVES: IspCacheNodeDrive[] = [
  { physicalPath: "/var/mcc", sizeInGb: 100, cacheNumber: 1 },
];

const getNode = (
  subscriptionId: string,
  resourceGroupName: string,
  customerResourceName: string,
  cacheNodeResourceName: string,
) =>
  orUndefinedIfNotFound(
    connectedcache.GetIspCacheNodesOperation({
      subscriptionId,
      resourceGroupName,
      customerResourceName,
      cacheNodeResourceName,
    }),
  );

const drivesOf = (node: ObservedNode): IspCacheNodeDrive[] =>
  (node.properties?.additionalCacheNodeProperties?.driveConfiguration ?? [])
    .map((drive) => ({
      physicalPath: drive.physicalPath ?? "",
      sizeInGb: drive.sizeInGb ?? 0,
      cacheNumber: drive.cacheNumber ?? 0,
    }))
    .sort((a, b) => a.cacheNumber - b.cacheNumber);

const sameDrives = (a: ReadonlyArray<IspCacheNodeDrive>, b: ReadonlyArray<IspCacheNodeDrive>) => {
  const key = (drives: ReadonlyArray<IspCacheNodeDrive>) =>
    JSON.stringify(
      [...drives]
        .sort((x, y) => x.cacheNumber - y.cacheNumber)
        .map((d) => [d.cacheNumber, d.physicalPath, d.sizeInGb]),
    );
  return key(a) === key(b);
};

const sameCidrs = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
  JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

const proxyOf = (node: ObservedNode) => {
  const url = node.properties?.additionalCacheNodeProperties?.proxyUrlConfiguration?.proxyUrl;
  return url === "" ? undefined : url;
};

const toAttrs = (
  resourceGroup: string,
  customer: string,
  name: string,
  node: ObservedNode,
  tags: Record<string, string>,
): IspCacheNode["Attributes"] => ({
  cacheNodeResourceName: name,
  cacheNodeResourceId: node.id ?? "",
  customer,
  resourceGroup,
  location: node.location,
  cacheNodeId: node.properties?.cacheNode?.cacheNodeId,
  customerId: node.properties?.cacheNode?.customerId,
  cacheNodeName: node.properties?.cacheNode?.cacheNodeName,
  ipAddress: node.properties?.cacheNode?.ipAddress,
  cidrCsv: [...(node.properties?.cacheNode?.cidrCsv ?? [])],
  osType: node.properties?.additionalCacheNodeProperties?.osType,
  driveConfiguration: drivesOf(node),
  maxAllowableEgressInMbps: node.properties?.cacheNode?.maxAllowableEgressInMbps,
  isEnabled: node.properties?.cacheNode?.isEnabled,
  proxyUrl: proxyOf(node),
  autoUpdateRingType: node.properties?.cacheNode?.autoUpdateRingType,
  isProvisioned: node.properties?.additionalCacheNodeProperties?.isProvisioned,
  provisioningState: node.properties?.provisioningState,
  tags,
});

/** A node is ours when its parent customer carries this stack/stage's tags. */
const parentOwned = (
  subscriptionId: string,
  resourceGroupName: string,
  customerResourceName: string,
) =>
  Effect.gen(function* () {
    const customer = yield* orUndefinedIfNotFound(
      connectedcache.GetIspCustomer({
        subscriptionId,
        resourceGroupName,
        customerResourceName,
      }),
    );
    const { stack, stage } = yield* stackAndStage;
    return (
      customer?.tags?.["alchemy::stack"] === stack && customer?.tags?.["alchemy::stage"] === stage
    );
  });

export const IspCacheNodeProvider = () =>
  Provider.succeed(IspCacheNode, {
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
        (news.name !== undefined && !sameArm(news.name, output.cacheNodeResourceName)) ||
        (news.location !== undefined && !sameArm(news.location, output.location)) ||
        (output.osType !== undefined && !sameArm(news.osType ?? "Linux", output.osType))
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
        output?.cacheNodeResourceName ?? olds?.name ?? (yield* createConnectedCacheName(id));
      const observed = yield* getNode(subscriptionId, resourceGroup, customer, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(
        resourceGroup,
        customer,
        name,
        observed,
        observed.tags === undefined ? (output?.tags ?? {}) : userTags(observed.tags),
      );
      return (yield* parentOwned(subscriptionId, resourceGroup, customer)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.ConnectedCache");
      const resourceGroup = news.resourceGroup;
      const customer = news.customer;
      const name =
        news.name ?? output?.cacheNodeResourceName ?? (yield* createConnectedCacheName(id));
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        customerResourceName: customer,
        cacheNodeResourceName: name,
      };
      const get = getNode(subscriptionId, resourceGroup, customer, name);
      const label = `Connected Cache ISP cache node ${name}`;
      const desired = {
        cacheNodeName: news.cacheNodeName ?? name,
        ipAddress: news.ipAddress,
        cidrCsv: news.cidrCsv,
        osType: news.osType ?? "Linux",
        drives: news.driveConfiguration ?? DEFAULT_DRIVES,
        maxAllowableEgressInMbps: news.maxAllowableEgressInMbps,
        isEnabled: news.isEnabled ?? false,
        proxyUrl: news.proxyUrl,
        autoUpdateRingType: news.autoUpdateRingType,
      };
      const put = (location: string) =>
        connectedcache.IspCacheNodesOperationsCreateOrUpdate({
          ...where,
          location,
          tags,
          properties: {
            cacheNode: {
              cacheNodeName: desired.cacheNodeName,
              ipAddress: desired.ipAddress,
              cidrCsv: desired.cidrCsv,
              maxAllowableEgressInMbps: desired.maxAllowableEgressInMbps,
              isEnabled: desired.isEnabled,
              autoUpdateRingType: desired.autoUpdateRingType,
            },
            additionalCacheNodeProperties: {
              osType: desired.osType,
              driveConfiguration: desired.drives,
              isProxyRequired: desired.proxyUrl === undefined ? "None" : "Required",
              proxyUrlConfiguration:
                desired.proxyUrl === undefined ? undefined : { proxyUrl: desired.proxyUrl },
            },
          },
        });
      // Replicas of the RP can briefly serve the pre-PUT body, so a write
      // is settled only once the desired configuration is observed.
      const configDiffers = (node: ObservedNode) => {
        const entity = node.properties?.cacheNode;
        return (
          entity?.cacheNodeName !== desired.cacheNodeName ||
          (desired.ipAddress !== undefined && entity?.ipAddress !== desired.ipAddress) ||
          (desired.cidrCsv !== undefined && !sameCidrs(entity?.cidrCsv ?? [], desired.cidrCsv)) ||
          (desired.maxAllowableEgressInMbps !== undefined &&
            entity?.maxAllowableEgressInMbps !== desired.maxAllowableEgressInMbps) ||
          (entity?.isEnabled ?? false) !== desired.isEnabled ||
          (desired.autoUpdateRingType !== undefined &&
            entity?.autoUpdateRingType !== desired.autoUpdateRingType) ||
          !sameDrives(drivesOf(node), desired.drives) ||
          proxyOf(node) !== desired.proxyUrl
        );
      };
      const settled = (node: ObservedNode) =>
        configDiffers(node) ? "Updating" : node.properties?.provisioningState;

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        const parent = yield* connectedcache.GetIspCustomer({
          subscriptionId,
          resourceGroupName: resourceGroup,
          customerResourceName: customer,
        });
        yield* put(news.location ?? output?.location ?? parent.location);
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

      // Sync tags. Cache node reads may omit tags, so the PATCH response is
      // the observation; it is a cheap idempotent write.
      const patched = yield* connectedcache.UpdateIspCacheNodesOperation({
        ...where,
        tags,
      });

      return toAttrs(resourceGroup, customer, name, observed, userTags(patched.tags ?? tags));
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* deleteUntilGone(
        `Connected Cache ISP cache node ${output.cacheNodeResourceName}`,
        ignoreNotFound(
          connectedcache.DeleteIspCacheNodesOperation({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            customerResourceName: output.customer,
            cacheNodeResourceName: output.cacheNodeResourceName,
          }),
        ),
        getNode(
          subscriptionId,
          output.resourceGroup,
          output.customer,
          output.cacheNodeResourceName,
        ),
      );
    }),

    nuke: {
      dependsOn: ["Azure.ConnectedCache.IspCustomer", "Azure.Resources.ResourceGroup"],
    },
  });
