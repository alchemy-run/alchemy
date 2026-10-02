import * as devtestlabs from "@distilled.cloud/azure/devtestlabs";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createLabResourceName,
  DEVTESTLAB_NAMESPACE,
  diverges,
  labLocation,
} from "./Common.ts";

export type UsagePermission = "Default" | "Deny" | "Allow";

export interface LabSubnet {
  /** ARM ID of the subnet. */
  resourceId?: string;
  /** Name of the subnet as shown in the lab. */
  labSubnetName?: string;
  /** Whether VMs in the subnet may get a public IP. */
  allowPublicIp?: UsagePermission;
}

export interface LabSubnetOverride {
  /** ARM ID of the subnet. */
  resourceId?: string;
  /** Name of the subnet as shown in the lab. */
  labSubnetName?: string;
  /** Whether lab VMs may be created in the subnet. */
  useInVmCreationPermission?: UsagePermission;
  /** Whether VMs in the subnet may get a public IP. */
  usePublicIpAddressPermission?: UsagePermission;
  /** Ports exposed through the lab's shared public IP. */
  sharedPublicIpAddressConfiguration?: {
    allowedPorts?: {
      transportProtocol?: "Tcp" | "Udp";
      backendPort?: number;
    }[];
  };
  /** Virtual network pool the subnet belongs to. */
  virtualNetworkPoolName?: string;
}

export interface LabVirtualNetworkProps {
  /** Resource group of the lab. Changing it replaces the registration. */
  resourceGroup: string;
  /** Name of the lab. Changing it replaces the registration. */
  lab: string;
  /**
   * Name of the lab virtual network. If omitted, a unique name is
   * generated from the app, stage, and logical ID. Changing it replaces
   * the registration.
   */
  name?: string;
  /**
   * ARM ID of the `Microsoft.Network/virtualNetworks` to use for lab VMs.
   * Changing it replaces the registration.
   */
  externalProviderResourceId: string;
  /** Description of the lab virtual network. */
  description?: string;
  /** Subnets lab VMs may use. */
  allowedSubnets?: LabSubnet[];
  /** Per-subnet settings for lab VM creation and public IPs. */
  subnetOverrides?: LabSubnetOverride[];
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface LabVirtualNetwork extends Resource<
  "Azure.DevTestLabs.LabVirtualNetwork",
  LabVirtualNetworkProps,
  {
    /** Name of the lab virtual network. */
    labVirtualNetworkName: string;
    /** ARM resource ID of the lab virtual network; use it for lab VMs. */
    labVirtualNetworkId: string;
    /** Resource group of the lab. */
    resourceGroup: string;
    /** Name of the lab. */
    lab: string;
    /** ARM ID of the registered virtual network. */
    externalProviderResourceId: string;
    /** Subnets of the registered virtual network. */
    externalSubnets: { id: string | undefined; name: string | undefined }[];
    /** Unique immutable identifier (GUID). */
    uniqueIdentifier: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * Registers an existing virtual network with a DevTest Lab so lab VMs can
 * be placed in its subnets.
 *
 * @see https://learn.microsoft.com/azure/devtest-labs/devtest-lab-configure-vnet
 *
 * ### Registering a Virtual Network
 * **Example:** Allow lab VMs in one subnet
 * ```typescript
 * const network = yield* Azure.DevTestLabs.LabVirtualNetwork("net", {
 *   resourceGroup: group.resourceGroupName,
 *   lab: lab.labName,
 *   externalProviderResourceId: vnet.virtualNetworkId,
 *   subnetOverrides: [
 *     {
 *       resourceId: subnet.subnetId,
 *       labSubnetName: subnet.subnetName,
 *       useInVmCreationPermission: "Allow",
 *       usePublicIpAddressPermission: "Deny",
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const LabVirtualNetwork = Resource<LabVirtualNetwork>(
  "Azure.DevTestLabs.LabVirtualNetwork",
);

const getNetwork = (
  subscriptionId: string,
  resourceGroupName: string,
  labName: string,
  name: string,
) =>
  orUndefinedIfNotFound(
    devtestlabs.GetVirtualNetwork({
      subscriptionId,
      resourceGroupName,
      labName,
      name,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  lab: string,
  name: string,
  n: devtestlabs.GetVirtualNetworkResponse,
): LabVirtualNetwork["Attributes"] => ({
  labVirtualNetworkName: name,
  labVirtualNetworkId: n.id ?? "",
  resourceGroup,
  lab,
  externalProviderResourceId: n.properties?.externalProviderResourceId ?? "",
  externalSubnets: (n.properties?.externalSubnets ?? []).map((s) => ({
    id: s.id,
    name: s.name,
  })),
  uniqueIdentifier: n.properties?.uniqueIdentifier,
  tags: userTags(n.tags),
});

export const LabVirtualNetworkProvider = () =>
  Provider.succeed(LabVirtualNetwork, {
    stables: [
      "labVirtualNetworkName",
      "labVirtualNetworkId",
      "resourceGroup",
      "lab",
      "externalProviderResourceId",
    ],

    // Lab virtual networks are deleted with their lab.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.lab.toLowerCase() !== output.lab.toLowerCase() ||
        news.externalProviderResourceId.toLowerCase() !==
          output.externalProviderResourceId.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !==
            output.labVirtualNetworkName.toLowerCase())
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const lab = output?.lab ?? olds?.lab;
      if (resourceGroup === undefined || lab === undefined) return undefined;
      const name =
        output?.labVirtualNetworkName ??
        olds?.name ??
        (yield* createLabResourceName(id));
      const observed = yield* getNetwork(
        subscriptionId,
        resourceGroup,
        lab,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, lab, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, DEVTESTLAB_NAMESPACE);
      const { resourceGroup, lab } = news;
      const name =
        news.name ??
        output?.labVirtualNetworkName ??
        (yield* createLabResourceName(id));
      const tags = yield* desiredTags(id, news.tags);
      const properties: devtestlabs.VirtualNetworkPropertiesInput = {
        externalProviderResourceId: news.externalProviderResourceId,
        description: news.description,
        allowedSubnets: news.allowedSubnets,
        subnetOverrides: news.subnetOverrides,
      };
      const get = getNetwork(subscriptionId, resourceGroup, lab, name);
      const wait = waitForProvisioned(
        `lab virtual network ${name}`,
        get,
        (n) => n.properties?.provisioningState,
        { interval: "3 seconds", times: 60 },
      );

      // Observe.
      let observed = yield* get;
      if (observed !== undefined) observed = yield* wait;

      // Ensure + sync: the PUT is a long-running full upsert.
      if (
        observed === undefined ||
        diverges(properties, observed.properties) ||
        tagsDiffer(observed.tags, tags)
      ) {
        yield* devtestlabs.VirtualNetworksCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          labName: lab,
          name,
          location:
            observed?.location ??
            (yield* labLocation(subscriptionId, resourceGroup, lab)),
          tags,
          properties,
        });
        observed = yield* wait;
      }

      return toAttrs(resourceGroup, lab, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        devtestlabs.DeleteVirtualNetwork({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          labName: output.lab,
          name: output.labVirtualNetworkName,
        }),
      );
      yield* waitUntilGone(
        `lab virtual network ${output.labVirtualNetworkName}`,
        getNetwork(
          subscriptionId,
          output.resourceGroup,
          output.lab,
          output.labVirtualNetworkName,
        ),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
