import * as compute from "@distilled.cloud/azure/compute";
import * as guestconfiguration from "@distilled.cloud/azure/guestconfiguration";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  type AssignmentAttributes,
  type AssignmentProps,
  assignmentDrifted,
  assignmentNameOf,
  assignmentReplaced,
  assignmentState,
  desiredProperties,
  sameId,
  toAssignmentAttrs,
  whileLookupFails,
} from "./Common.ts";

export interface VirtualMachineAssignmentProps extends AssignmentProps {
  /**
   * Name of the virtual machine the configuration is assigned to. Changing
   * it replaces the assignment.
   */
  virtualMachine: string;
}

export interface VirtualMachineAssignment extends Resource<
  "Azure.GuestConfiguration.VirtualMachineAssignment",
  VirtualMachineAssignmentProps,
  AssignmentAttributes & {
    /** Name of the virtual machine. */
    virtualMachine: string;
  },
  never,
  Providers
> {}

/**
 * A machine configuration (guest configuration) assignment on an Azure
 * virtual machine — audits or applies an OS-level configuration package
 * such as the built-in Linux/Windows security baselines.
 *
 * Compliance is only evaluated when the VM has a system-assigned managed
 * identity and the guest configuration extension
 * (`Microsoft.GuestConfiguration` / `ConfigurationForLinux` or
 * `ConfigurationForWindows`); without them the assignment stays `Pending`.
 *
 * @see https://learn.microsoft.com/azure/governance/machine-configuration/overview
 *
 * ### Auditing a Baseline
 * **Example:** Audit the Azure Linux security baseline
 * ```typescript
 * const vm = yield* Azure.Compute.VirtualMachine("Vm", {
 *   resourceGroup: group.resourceGroupName,
 *   vmSize: "Standard_B1s",
 *   networkInterfaceIds: [nic.networkInterfaceId],
 *   adminUsername: "azureuser",
 *   sshPublicKeys: [publicKey],
 *   identity: { systemAssigned: true },
 * });
 * yield* Azure.Compute.VirtualMachineExtension("GuestConfig", {
 *   resourceGroup: group.resourceGroupName,
 *   virtualMachine: vm.virtualMachineName,
 *   publisher: "Microsoft.GuestConfiguration",
 *   type: "ConfigurationForLinux",
 *   typeHandlerVersion: "1.0",
 *   enableAutomaticUpgrade: true,
 * });
 * const baseline = yield* Azure.GuestConfiguration.VirtualMachineAssignment(
 *   "Baseline",
 *   {
 *     resourceGroup: group.resourceGroupName,
 *     virtualMachine: vm.virtualMachineName,
 *     configurationName: "AzureLinuxBaseline",
 *     configurationVersion: "1.*",
 *   },
 * );
 * ```
 *
 * ### Parameters
 * **Example:** Audit with configuration parameters
 * ```typescript
 * yield* Azure.GuestConfiguration.VirtualMachineAssignment("Baseline", {
 *   resourceGroup: group.resourceGroupName,
 *   virtualMachine: vm.virtualMachineName,
 *   configurationName: "AzureLinuxBaseline",
 *   configurationVersion: "1.*",
 *   assignmentType: "ApplyAndMonitor",
 *   parameters: { "Ensure SSH root login is disabled;ExpectedValue": "true" },
 * });
 * ```
 *
 * ### Custom Packages
 * **Example:** Assign a custom package from blob storage
 * ```typescript
 * yield* Azure.GuestConfiguration.VirtualMachineAssignment("Custom", {
 *   resourceGroup: group.resourceGroupName,
 *   virtualMachine: vm.virtualMachineName,
 *   configurationName: "MyConfig",
 *   configurationVersion: "1.0.0",
 *   contentUri: packageSasUrl,
 *   contentHash: packageSha256,
 *   assignmentType: "ApplyAndAutoCorrect",
 * });
 * ```
 *
 * @resource
 */
export const VirtualMachineAssignment = Resource<VirtualMachineAssignment>(
  "Azure.GuestConfiguration.VirtualMachineAssignment",
);

/**
 * Observe through the list endpoint: GET intermittently fails with
 * `GuestConfigurationMachineLookupFailed` for minutes after the host is
 * created, while the list stays reliable.
 */
const getAssignment = (
  subscriptionId: string,
  resourceGroupName: string,
  vmName: string,
  name: string,
) =>
  orUndefinedIfNotFound(
    guestconfiguration.ListGuestConfigurationAssignments({
      subscriptionId,
      resourceGroupName,
      vmName,
    }),
  ).pipe(
    Effect.retry(whileLookupFails),
    Effect.map((page) =>
      page?.value?.find(
        (assignment) => assignment.name.toLowerCase() === name.toLowerCase(),
      ),
    ),
  );

const toAttrs = (
  resourceGroup: string,
  vmName: string,
  name: string,
  location: string,
  configurationName: string,
  observed: guestconfiguration.GuestConfigurationAssignment,
): VirtualMachineAssignment["Attributes"] => ({
  ...toAssignmentAttrs(
    resourceGroup,
    name,
    location,
    configurationName,
    observed,
  ),
  virtualMachine: vmName,
});

export const VirtualMachineAssignmentProvider = () =>
  Provider.succeed(VirtualMachineAssignment, {
    stables: [
      "assignmentName",
      "assignmentId",
      "resourceGroup",
      "location",
      "configurationName",
      "virtualMachine",
    ],

    // Assignments are deleted with their VM and carry no ownership marker.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameId(news.virtualMachine, output.virtualMachine) ||
        assignmentReplaced(news, output)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const vmName = output?.virtualMachine ?? olds?.virtualMachine;
      const name =
        output?.assignmentName ??
        (olds === undefined ? undefined : assignmentNameOf(olds));
      if (
        resourceGroup === undefined ||
        vmName === undefined ||
        name === undefined
      ) {
        return undefined;
      }
      const observed = yield* getAssignment(
        subscriptionId,
        resourceGroup,
        vmName,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(
        resourceGroup,
        vmName,
        name,
        observed.location ?? "",
        observed.properties?.guestConfiguration?.name ?? name,
        observed,
      );
      // No tags or writable markers: only an assignment we have state for
      // is ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news, olds, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.GuestConfiguration");
      const resourceGroup = news.resourceGroup;
      const vmName = news.virtualMachine;
      const name = assignmentNameOf(news);
      const location =
        news.location ??
        output?.location ??
        (yield* orUndefinedIfNotFound(
          compute.GetVirtualMachine({
            subscriptionId,
            resourceGroupName: resourceGroup,
            vmName,
          }),
        ).pipe(Effect.map((vm) => vm?.location))) ??
        env.location;
      const get = getAssignment(subscriptionId, resourceGroup, vmName, name);

      // Observe.
      const observed = yield* get;

      // Ensure, or re-PUT the full definition when anything drifted (no
      // PATCH exists).
      if (observed === undefined || assignmentDrifted(observed, news, olds)) {
        yield* guestconfiguration
          .GuestConfigurationAssignmentsCreateOrUpdate({
            subscriptionId,
            resourceGroupName: resourceGroup,
            vmName,
            guestConfigurationAssignmentName: name,
            name,
            location,
            properties: desiredProperties(news),
          })
          .pipe(Effect.retry(whileLookupFails));
      }
      const fresh = yield* waitForProvisioned(
        `guest configuration assignment ${name}`,
        get,
        assignmentState,
      );
      return toAttrs(
        resourceGroup,
        vmName,
        name,
        location,
        news.configurationName,
        fresh,
      );
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        guestconfiguration.DeleteGuestConfigurationAssignment({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          vmName: output.virtualMachine,
          guestConfigurationAssignmentName: output.assignmentName,
        }),
      ).pipe(Effect.retry(whileLookupFails));
      yield* waitUntilGone(
        `guest configuration assignment ${output.assignmentName}`,
        getAssignment(
          subscriptionId,
          output.resourceGroup,
          output.virtualMachine,
          output.assignmentName,
        ),
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Compute.VirtualMachine",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
