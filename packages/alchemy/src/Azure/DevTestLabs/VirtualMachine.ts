import * as compute from "@distilled.cloud/azure/compute";
import * as devtestlabs from "@distilled.cloud/azure/devtestlabs";
import * as network from "@distilled.cloud/azure/network";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { DEVTESTLAB_NAMESPACE, labLocation, vmSettingsInput } from "./Common.ts";
import type { FormulaVmSettings } from "./Formula.ts";

export interface VirtualMachineProps extends FormulaVmSettings {
  /** Resource group of the lab. Changing it replaces the VM. */
  resourceGroup: string;
  /** Name of the lab. Changing it replaces the VM. */
  lab: string;
  /**
   * VM name: up to 15 letters, digits, and `-` (the Windows limit, also
   * used for Linux). If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the VM.
   */
  name?: string;
  /** VM size, e.g. `"Standard_B1s"`. Changing it resizes the VM in place. */
  size: string;
  /** ISO 8601 time after which the lab deletes the VM. Changing it replaces the VM. */
  expirationDate?: string;
  /** Object ID of the lab user who owns the VM. Changing it replaces the VM. */
  ownerObjectId?: string;
  /** UPN of the lab user who owns the VM. Changing it replaces the VM. */
  ownerUserPrincipalName?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface VirtualMachine extends Resource<
  "Azure.DevTestLabs.VirtualMachine",
  VirtualMachineProps,
  {
    /** Name of the lab VM. */
    virtualMachineName: string;
    /** ARM resource ID of the lab VM. */
    virtualMachineId: string;
    /** Resource group of the lab. */
    resourceGroup: string;
    /** Name of the lab. */
    lab: string;
    /** ARM ID of the underlying `Microsoft.Compute/virtualMachines`. */
    computeId: string | undefined;
    /** Current VM size. */
    size: string | undefined;
    /** OS type of the VM. */
    osType: string | undefined;
    /** Fully qualified DNS name of the VM. */
    fqdn: string | undefined;
    /** Private IP address of the VM. */
    privateIpAddress: string | undefined;
    /** Public IP address of the VM, if any. */
    publicIpAddress: string | undefined;
    /** Creator of the VM. */
    createdByUser: string | undefined;
    /** Unique immutable identifier (GUID). */
    uniqueIdentifier: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A DevTest Labs virtual machine — a VM created and governed by a lab
 * (policies, auto-shutdown, artifacts, claimable pools).
 *
 * @see https://learn.microsoft.com/azure/devtest-labs/devtest-lab-add-vm
 *
 * ### Creating a Lab VM
 * **Example:** Ubuntu VM with an SSH key
 * ```typescript
 * const vm = yield* Azure.DevTestLabs.VirtualMachine("dev", {
 *   resourceGroup: group.resourceGroupName,
 *   lab: lab.labName,
 *   size: "Standard_B1s",
 *   galleryImageReference: {
 *     publisher: "Canonical",
 *     offer: "0001-com-ubuntu-server-jammy",
 *     sku: "22_04-lts-gen2",
 *     osType: "Linux",
 *   },
 *   userName: "azureuser",
 *   isAuthenticationWithSshKey: true,
 *   sshKey: publicKey,
 *   labVirtualNetworkId: network.labVirtualNetworkId,
 *   labSubnetName: subnet.subnetName,
 *   disallowPublicIpAddress: true,
 * });
 * ```
 *
 * ### Claimable VMs
 * **Example:** Pool VM any lab user can claim
 * ```typescript
 * const pooled = yield* Azure.DevTestLabs.VirtualMachine("pool-1", {
 *   resourceGroup: group.resourceGroupName,
 *   lab: lab.labName,
 *   size: "Standard_B2s",
 *   customImageId: image.customImageId,
 *   userName: "azureuser",
 *   password: Redacted.make(vmPassword),
 *   allowClaim: true,
 * });
 * ```
 *
 * @resource
 */
export const VirtualMachine = Resource<VirtualMachine>(
  "Azure.DevTestLabs.VirtualMachine",
);

const createVmName = (id: string) =>
  createPhysicalName({ id, maxLength: 15, suffixLength: 6, lowercase: true });

const getVm = (
  subscriptionId: string,
  resourceGroupName: string,
  labName: string,
  name: string,
) =>
  orUndefinedIfNotFound(
    devtestlabs.GetVirtualMachine({
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
  vm: devtestlabs.GetVirtualMachineResponse,
): VirtualMachine["Attributes"] => {
  const p = vm.properties ?? {};
  return {
    virtualMachineName: name,
    virtualMachineId: vm.id ?? "",
    resourceGroup,
    lab,
    computeId: p.computeId,
    size: p.size,
    osType: p.osType,
    fqdn: p.fqdn,
    privateIpAddress: p.networkInterface?.privateIpAddress,
    publicIpAddress: p.networkInterface?.publicIpAddress,
    createdByUser: p.createdByUser,
    uniqueIdentifier: p.uniqueIdentifier,
    tags: userTags(vm.tags),
  };
};

/** Private IP of the compute VM's primary NIC (lab VMs live in their own group). */
const computePrivateIp = (subscriptionId: string, computeId: string | undefined) =>
  Effect.gen(function* () {
    const vmGroup = resourceGroupOf(computeId);
    const vmName = computeId?.split("/").at(-1);
    if (vmGroup === undefined || vmName === undefined) return undefined;
    const vm = yield* orUndefinedIfNotFound(
      compute.GetVirtualMachine({
        subscriptionId,
        resourceGroupName: vmGroup,
        vmName,
      }),
    );
    const nics = vm?.properties?.networkProfile?.networkInterfaces ?? [];
    const nicId = (nics.find((nic) => nic.properties?.primary) ?? nics[0])?.id;
    const nicGroup = resourceGroupOf(nicId);
    const nicName = nicId?.split("/").at(-1);
    if (nicGroup === undefined || nicName === undefined) return undefined;
    const nic = yield* orUndefinedIfNotFound(
      network.GetNetworkInterface({
        subscriptionId,
        resourceGroupName: nicGroup,
        networkInterfaceName: nicName,
      }),
    );
    const configs = nic?.properties?.ipConfigurations ?? [];
    return (configs.find((c) => c.properties?.primary) ?? configs[0])
      ?.properties?.privateIPAddress;
  });

/** Creation-time settings (everything but size and tags). */
const fixedSettings = (props: VirtualMachineProps) =>
  JSON.stringify({
    ...vmSettingsInput({ ...props, size: undefined }),
    password:
      props.password === undefined ? undefined : Redacted.value(props.password),
    expirationDate: props.expirationDate,
    ownerObjectId: props.ownerObjectId,
    ownerUserPrincipalName: props.ownerUserPrincipalName,
  });

export const VirtualMachineProvider = () =>
  Provider.succeed(VirtualMachine, {
    stables: ["virtualMachineName", "virtualMachineId", "resourceGroup", "lab"],

    // Lab VMs are deleted with their lab.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.lab.toLowerCase() !== output.lab.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.virtualMachineName.toLowerCase()) ||
        (olds !== undefined && fixedSettings(news) !== fixedSettings(olds))
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
        output?.virtualMachineName ?? olds?.name ?? (yield* createVmName(id));
      const observed = yield* getVm(subscriptionId, resourceGroup, lab, name);
      if (observed === undefined) return undefined;
      const attrs = {
        ...toAttrs(resourceGroup, lab, name, observed),
        privateIpAddress: yield* computePrivateIp(
          subscriptionId,
          observed.properties?.computeId,
        ),
      };
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, DEVTESTLAB_NAMESPACE);
      const { resourceGroup, lab } = news;
      const name =
        news.name ?? output?.virtualMachineName ?? (yield* createVmName(id));
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        labName: lab,
        name,
      };
      const get = getVm(subscriptionId, resourceGroup, lab, name);
      const wait = waitForProvisioned(
        `lab VM ${name}`,
        get,
        (vm) => vm.properties?.provisioningState,
        // Lab VM creation (image + artifacts) takes 5-10 minutes.
        { interval: "10 seconds", times: 90 },
      );

      // Observe.
      let observed = yield* get;
      if (observed !== undefined) observed = yield* wait;

      // Ensure. Creation settings are fixed (changes replace the VM).
      if (observed === undefined) {
        yield* devtestlabs.VirtualMachinesCreateOrUpdate({
          ...where,
          location: yield* labLocation(subscriptionId, resourceGroup, lab),
          tags,
          properties: {
            ...vmSettingsInput(news),
            password:
              news.password === undefined
                ? undefined
                : Redacted.value(news.password),
            expirationDate: news.expirationDate,
            ownerObjectId: news.ownerObjectId,
            ownerUserPrincipalName: news.ownerUserPrincipalName,
          },
        });
        observed = yield* wait;
      }

      // Sync size via the resize action. It is a long-running POST whose
      // failure (e.g. SkuNotAvailable) only shows on its async operation,
      // which the SDK does not poll: the lab VM keeps its old size and the
      // bounded wait below times out.
      if (observed.properties?.size?.toLowerCase() !== news.size.toLowerCase()) {
        yield* devtestlabs.ResizeVirtualMachine({ ...where, size: news.size });
        observed = yield* waitForProvisioned(
          `lab VM ${name} resize`,
          get,
          (vm) =>
            vm.properties?.provisioningState === "Failed"
              ? "Failed"
              : vm.properties?.size?.toLowerCase() === news.size.toLowerCase()
                ? vm.properties?.provisioningState
                : "Updating",
          { interval: "10 seconds", times: 60 },
        );
      }

      // Sync tags (PATCH updates tags only).
      if (tagsDiffer(observed.tags, tags)) {
        yield* devtestlabs.UpdateVirtualMachine({ ...where, tags });
        observed = yield* wait;
      }

      // The lab omits the NIC unless `$expand`ed, so read the private IP
      // from the underlying compute VM's primary NIC.
      const privateIpAddress = yield* computePrivateIp(
        subscriptionId,
        observed.properties?.computeId,
      );

      return {
        ...toAttrs(resourceGroup, lab, name, observed),
        privateIpAddress,
      };
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        devtestlabs.DeleteVirtualMachine({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          labName: output.lab,
          name: output.virtualMachineName,
        }),
      );
      yield* waitUntilGone(
        `lab VM ${output.virtualMachineName}`,
        getVm(
          subscriptionId,
          output.resourceGroup,
          output.lab,
          output.virtualMachineName,
        ),
        { interval: "10 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
