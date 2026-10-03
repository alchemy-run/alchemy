import * as hci from "@distilled.cloud/azure/azurestackhci";
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
  orUndefinedIfNotFound,
  requireSinglePage,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { HCI_NAMESPACE, sameId, sameValue } from "./Common.ts";

/** Site the machine is shipped to and its target device configuration. */
export type EdgeMachineSiteDetails = hci.SiteDetails;
/** OS provisioning profile and users of the machine. */
export type EdgeMachineProvisioningDetails = hci.ProvisioningDetails;
/** FIDO device onboarding ownership voucher of the machine. */
export type EdgeMachineOwnershipVoucher = hci.OwnershipVoucherDetailsInput;

export interface EdgeMachineProps {
  /** Resource group the edge machine is created in. Changing it replaces the machine. */
  resourceGroup: string;
  /**
   * Name of the edge machine. If omitted, a unique name is generated from
   * the app, stage, and logical ID. Changing it replaces the machine.
   */
  name?: string;
  /**
   * Azure region of the edge machine record. Changing it replaces the machine.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Kind of edge machine. Changing it replaces the machine.
   * @default "Standard"
   */
  edgeMachineKind?: "Standard" | "Dedicated";
  /**
   * ARM ID of the Arc-enabled server (`Microsoft.HybridCompute/machines`)
   * running an Azure Local OS that backs this machine.
   */
  arcMachineResourceId?: string;
  /**
   * ARM ID of the resource group the Arc machine is created in. Changing
   * it replaces the machine.
   */
  arcMachineResourceGroupId?: string;
  /** ARM ID of the Arc gateway the machine connects through. */
  arcGatewayResourceId?: string;
  /** Site and target device configuration. */
  siteDetails?: EdgeMachineSiteDetails;
  /** Ownership voucher used to claim the hardware. */
  ownershipVoucherDetails?: EdgeMachineOwnershipVoucher;
  /** OS provisioning profile. */
  provisioningDetails?: EdgeMachineProvisioningDetails;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface EdgeMachine extends Resource<
  "Azure.AzureStackHCI.EdgeMachine",
  EdgeMachineProps,
  {
    /** Name of the edge machine. */
    edgeMachineName: string;
    /** Resource group that holds the edge machine. */
    resourceGroup: string;
    /** ARM resource ID of the edge machine. */
    edgeMachineId: string;
    /** Azure region of the edge machine record. */
    location: string;
    /** Kind of edge machine. */
    edgeMachineKind: string | undefined;
    /** Unique, immutable ID of the edge machine. */
    cloudId: string | undefined;
    /** ARM ID of the backing Arc-enabled server. */
    arcMachineResourceId: string | undefined;
    /** Lifecycle state of the machine, e.g. `Claimed`, `Provisioned`. */
    machineState: string | undefined;
    /** Connectivity of the machine to Azure. */
    connectivityStatus: string | undefined;
    /** Object ID of the machine's system-assigned identity. */
    principalId: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A bare-metal Azure Local machine record used by the zero-touch
 * provisioning flow: claimed with the hardware's ownership voucher and
 * bound to the Arc-enabled server running Azure Local's Linux-based OS.
 * Creation is validated against that Arc machine's reported OS SKU, so it
 * needs real Azure Local hardware.
 *
 * @see https://learn.microsoft.com/azure/azure-local/overview
 *
 * ### Registering a Machine
 * **Example:** Edge machine backed by an Arc-enabled server
 * ```typescript
 * const machine = yield* Azure.AzureStackHCI.EdgeMachine("node-1", {
 *   resourceGroup: group.resourceGroupName,
 *   arcMachineResourceId: arcServerId,
 *   tags: { rack: "r1" },
 * });
 * ```
 *
 * @resource
 */
export const EdgeMachine = Resource<EdgeMachine>(
  "Azure.AzureStackHCI.EdgeMachine",
);

export const getHciEdgeMachine = (
  subscriptionId: string,
  resourceGroupName: string,
  edgeMachineName: string,
) =>
  orUndefinedIfNotFound(
    hci.GetEdgeMachine({ subscriptionId, resourceGroupName, edgeMachineName }),
  );

const createMachineName = (id: string) =>
  createPhysicalName({ id, maxLength: 63 });

const toAttrs = (
  resourceGroup: string,
  name: string,
  machine: hci.GetEdgeMachineResponse,
): EdgeMachine["Attributes"] => ({
  edgeMachineName: name,
  resourceGroup,
  edgeMachineId: machine.id ?? "",
  location: machine.location,
  edgeMachineKind: machine.properties?.edgeMachineKind,
  cloudId: machine.properties?.cloudId,
  arcMachineResourceId: machine.properties?.arcMachineResourceId,
  machineState: machine.properties?.machineState,
  connectivityStatus: machine.properties?.connectivityStatus,
  principalId: machine.identity?.principalId,
  tags: userTags(machine.tags),
});

export const EdgeMachineProvider = () =>
  Provider.succeed(EdgeMachine, {
    stables: ["edgeMachineName", "resourceGroup", "edgeMachineId", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* orUndefinedIfNotFound(
        hci
          .ListEdgeMachineBySubscription({ subscriptionId })
          .pipe(
            Effect.flatMap((page) =>
              requireSinglePage("ListEdgeMachineBySubscription", page),
            ),
          ),
      );
      return (page?.value ?? []).flatMap((machine) => {
        const group = resourceGroupOf(machine.id);
        return hasAnyAlchemyTag(machine.tags) &&
          group !== undefined &&
          machine.name !== undefined
          ? [toAttrs(group, machine.name, machine)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameId(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined &&
          !sameId(news.name, output.edgeMachineName)) ||
        (news.location !== undefined &&
          !sameId(news.location, output.location)) ||
        (output.edgeMachineKind !== undefined &&
          (news.edgeMachineKind ?? "Standard") !== output.edgeMachineKind) ||
        (olds !== undefined &&
          !sameId(
            news.arcMachineResourceGroupId,
            olds.arcMachineResourceGroupId,
          ))
      ) {
        // An explicit name is reused by the replacement, so the old one
        // must go first; generated names differ per instance.
        return {
          action: "replace",
          deleteFirst: news.name !== undefined,
        } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.edgeMachineName ?? olds?.name ?? (yield* createMachineName(id));
      const observed = yield* getHciEdgeMachine(
        subscriptionId,
        resourceGroup,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, HCI_NAMESPACE);
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.edgeMachineName ?? (yield* createMachineName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        edgeMachineName: name,
      };
      const get = getHciEdgeMachine(subscriptionId, resourceGroup, name);
      const settle = waitForProvisioned(
        `edge machine ${name}`,
        get,
        (machine) => machine.properties?.provisioningState,
        { interval: "5 seconds", times: 60 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure + sync the machine properties. Only tags and identity can be
      // patched; everything else converges through the PUT upsert. Struct
      // props that Azure redacts (voucher) or normalizes are compared with
      // the last deployed props.
      const propsDrift =
        observed !== undefined &&
        ((news.arcMachineResourceId !== undefined &&
          !sameId(
            news.arcMachineResourceId,
            observed.properties?.arcMachineResourceId,
          )) ||
          (news.arcGatewayResourceId !== undefined &&
            !sameId(
              news.arcGatewayResourceId,
              observed.properties?.arcGatewayResourceId,
            )) ||
          (olds !== undefined &&
            (!sameValue(news.siteDetails, olds.siteDetails) ||
              !sameValue(news.provisioningDetails, olds.provisioningDetails) ||
              !sameValue(
                news.ownershipVoucherDetails,
                olds.ownershipVoucherDetails,
              ))));
      if (observed === undefined || propsDrift) {
        yield* hci.EdgeMachinesCreateOrUpdate({
          ...where,
          location: observed?.location ?? location,
          tags,
          identity: { type: "SystemAssigned" },
          properties: {
            edgeMachineKind: news.edgeMachineKind ?? "Standard",
            arcMachineResourceId: news.arcMachineResourceId,
            arcMachineResourceGroupId: news.arcMachineResourceGroupId,
            arcGatewayResourceId: news.arcGatewayResourceId,
            siteDetails: news.siteDetails,
            ownershipVoucherDetails: news.ownershipVoucherDetails,
            provisioningDetails: news.provisioningDetails,
          },
        });
        observed = yield* settle;
      }

      // Sync tags against the observed machine.
      if (tagsDiffer(observed.tags, tags)) {
        yield* hci.UpdateEdgeMachine({ ...where, tags });
        observed = yield* settle;
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        hci.DeleteEdgeMachine({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          edgeMachineName: output.edgeMachineName,
        }),
      );
      yield* waitUntilGone(
        `edge machine ${output.edgeMachineName}`,
        getHciEdgeMachine(
          subscriptionId,
          output.resourceGroup,
          output.edgeMachineName,
        ),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
