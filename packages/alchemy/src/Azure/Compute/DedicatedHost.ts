import * as compute from "@distilled.cloud/azure/compute";
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
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createComputeName,
  idsOf,
  sameId,
  waitComputeGone,
  waitComputeProvisioned,
  whileComputeBusy,
} from "./common.ts";

export interface DedicatedHostProps {
  /**
   * Resource group of the host group. Changing it replaces the host.
   */
  resourceGroup: string;
  /**
   * Name of the dedicated host group. Changing it replaces the host.
   */
  hostGroup: string;
  /**
   * Name of the host. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the host.
   */
  name?: string;
  /**
   * Location of the host.
   * @default the host group's location
   */
  location?: string;
  /**
   * Host SKU (hardware family and generation), e.g. `DSv3-Type4` or
   * `ESv5-Type1`. Changing it replaces the host.
   */
  sku: string;
  /**
   * Fault domain of the host within the group. Changing it replaces the
   * host.
   * @default 0
   */
  platformFaultDomain?: number;
  /**
   * Replace the host automatically on hardware failure.
   * @default true
   */
  autoReplaceOnFailure?: boolean;
  /**
   * Software license type for Windows Server VMs on the host
   * (`Windows_Server_Hybrid`, `Windows_Server_Perpetual`, or `None`).
   */
  licenseType?: "None" | "Windows_Server_Hybrid" | "Windows_Server_Perpetual";
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface DedicatedHost extends Resource<
  "Azure.Compute.DedicatedHost",
  DedicatedHostProps,
  {
    /** Name of the host. */
    hostName: string;
    /** ARM resource ID of the host; reference it from a VM's `hostId`. */
    dedicatedHostId: string;
    /** Unique ID of the physical host. */
    hostId: string | undefined;
    /** Name of the host group. */
    hostGroup: string;
    /** Resource group of the host group. */
    resourceGroup: string;
    /** Location of the host. */
    location: string;
    /** Host SKU. */
    sku: string | undefined;
    /** Fault domain of the host. */
    platformFaultDomain: number | undefined;
    /** ARM IDs of the VMs on the host. */
    virtualMachineIds: string[];
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure dedicated host — a whole physical server reserved for your
 * subscription, inside a `DedicatedHostGroup`. Hosts bill per hour for the
 * entire server (several dollars per hour) and need dedicated-host family
 * quota, which new and trial subscriptions do not have.
 *
 * @see https://learn.microsoft.com/azure/virtual-machines/dedicated-hosts
 *
 * ### Creating a Host
 * **Example:** DSv3 host in fault domain 0
 * ```typescript
 * const hostGroup = yield* Azure.Compute.DedicatedHostGroup("isolated", {
 *   resourceGroup: group.resourceGroupName,
 *   zones: ["1"],
 * });
 * const host = yield* Azure.Compute.DedicatedHost("host-1", {
 *   resourceGroup: group.resourceGroupName,
 *   hostGroup: hostGroup.hostGroupName,
 *   sku: "DSv3-Type4",
 * });
 * ```
 *
 * ### Placing a VM on the Host
 * **Example:** VM pinned to the host
 * ```typescript
 * const vm = yield* Azure.Compute.VirtualMachine("isolated-vm", {
 *   resourceGroup: group.resourceGroupName,
 *   vmSize: "Standard_D2s_v3",
 *   zones: ["1"],
 *   hostId: host.dedicatedHostId,
 *   networkInterfaceIds: [nic.networkInterfaceId],
 *   adminUsername: "azureuser",
 *   sshPublicKeys: [publicKey],
 * });
 * ```
 *
 * @resource
 */
export const DedicatedHost = Resource<DedicatedHost>(
  "Azure.Compute.DedicatedHost",
);

type Observed = compute.GetDedicatedHostResponse;

const getHost = (
  subscriptionId: string,
  resourceGroupName: string,
  hostGroupName: string,
  hostName: string,
) =>
  orUndefinedIfNotFound(
    compute.GetDedicatedHost({
      subscriptionId,
      resourceGroupName,
      hostGroupName,
      hostName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  hostGroup: string,
  name: string,
  host: Observed,
): DedicatedHost["Attributes"] => ({
  hostName: name,
  dedicatedHostId: host.id ?? "",
  hostId: host.properties?.hostId,
  hostGroup,
  resourceGroup,
  location: host.location,
  sku: host.sku?.name,
  platformFaultDomain: host.properties?.platformFaultDomain,
  virtualMachineIds: idsOf(host.properties?.virtualMachines),
  tags: userTags(host.tags),
});

export const DedicatedHostProvider = () =>
  Provider.succeed(DedicatedHost, {
    stables: [
      "hostName",
      "dedicatedHostId",
      "hostId",
      "hostGroup",
      "resourceGroup",
      "location",
    ],

    // Hosts are listed through their group; the group's delete waits for
    // them, and nuke deletes the resource group.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameId(news.resourceGroup, output.resourceGroup) ||
        !sameId(news.hostGroup, output.hostGroup) ||
        (news.name !== undefined && !sameId(news.name, output.hostName)) ||
        (news.location !== undefined &&
          !sameId(news.location, output.location)) ||
        !sameId(news.sku, output.sku) ||
        (news.platformFaultDomain ?? 0) !== (output.platformFaultDomain ?? 0)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const hostGroup = output?.hostGroup ?? olds?.hostGroup;
      if (resourceGroup === undefined || hostGroup === undefined) {
        return undefined;
      }
      const name =
        output?.hostName ?? olds?.name ?? (yield* createComputeName(id));
      const observed = yield* getHost(
        subscriptionId,
        resourceGroup,
        hostGroup,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, hostGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Compute");
      const resourceGroup = news.resourceGroup;
      const hostGroup = news.hostGroup;
      const name =
        news.name ?? output?.hostName ?? (yield* createComputeName(id));
      const groupLocation = yield* orUndefinedIfNotFound(
        compute.GetDedicatedHostGroup({
          subscriptionId,
          resourceGroupName: resourceGroup,
          hostGroupName: hostGroup,
        }),
      ).pipe(Effect.map((group) => group?.location));
      const location =
        news.location ?? output?.location ?? groupLocation ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const autoReplace = news.autoReplaceOnFailure ?? true;
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        hostGroupName: hostGroup,
        hostName: name,
      };
      const label = `dedicated host ${name}`;
      const get = getHost(subscriptionId, resourceGroup, hostGroup, name);

      // Observe.
      let observed = yield* get;

      // Ensure. Host allocation is a long-running operation.
      if (observed === undefined) {
        yield* compute
          .DedicatedHostsCreateOrUpdate({
            ...where,
            location,
            tags,
            sku: { name: news.sku },
            properties: {
              platformFaultDomain: news.platformFaultDomain ?? 0,
              autoReplaceOnFailure: autoReplace,
              licenseType: news.licenseType,
            },
          })
          .pipe(Effect.retry(whileComputeBusy));
      }
      observed = yield* waitComputeProvisioned(label, get);

      // Sync mutable settings and tags against observed state.
      const autoReplaceChanged =
        (observed.properties?.autoReplaceOnFailure ?? true) !== autoReplace;
      const licenseChanged =
        news.licenseType !== undefined &&
        (observed.properties?.licenseType ?? "None") !== news.licenseType;
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (autoReplaceChanged || licenseChanged || tagsChanged) {
        yield* compute
          .UpdateDedicatedHost({
            ...where,
            tags: tagsChanged ? tags : undefined,
            properties:
              autoReplaceChanged || licenseChanged
                ? {
                    autoReplaceOnFailure: autoReplace,
                    licenseType: news.licenseType,
                  }
                : undefined,
          })
          .pipe(Effect.retry(whileComputeBusy));
        observed = yield* waitComputeProvisioned(label, get);
      }
      return toAttrs(resourceGroup, hostGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        compute.DeleteDedicatedHost({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          hostGroupName: output.hostGroup,
          hostName: output.hostName,
        }),
      ).pipe(Effect.retry(whileComputeBusy));
      yield* waitComputeGone(
        `dedicated host ${output.hostName}`,
        getHost(
          subscriptionId,
          output.resourceGroup,
          output.hostGroup,
          output.hostName,
        ),
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Compute.DedicatedHostGroup",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
