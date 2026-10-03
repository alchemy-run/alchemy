import * as compute from "@distilled.cloud/azure/compute";
import * as guestconfiguration from "@distilled.cloud/azure/guestconfiguration";
import * as Data from "effect/Data";
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

export interface VirtualMachineScaleSetAssignmentProps extends AssignmentProps {
  /**
   * Name of the virtual machine scale set the configuration is assigned
   * to. Changing it replaces the assignment.
   */
  virtualMachineScaleSet: string;
}

export interface VirtualMachineScaleSetAssignment extends Resource<
  "Azure.GuestConfiguration.VirtualMachineScaleSetAssignment",
  VirtualMachineScaleSetAssignmentProps,
  AssignmentAttributes & {
    /** Name of the virtual machine scale set. */
    virtualMachineScaleSet: string;
    /** Per-instance compliance of the scale set's VMs. */
    instances: {
      /** UUID of the VM. */
      vmId: string | undefined;
      /** ARM ID of the VM. */
      vmResourceId: string | undefined;
      /** Compliance status of the VM. */
      complianceStatus: string | undefined;
      /** ID of the VM's latest compliance report. */
      latestReportId: string | undefined;
    }[];
  },
  never,
  Providers
> {}

/**
 * A machine configuration (guest configuration) assignment on an Azure
 * virtual machine scale set — audits or applies an OS-level configuration
 * package on every instance and reports per-instance compliance.
 *
 * As of API version `2024-04-05` the service answers scale set
 * assignments with an embedded `VMSSNotSupported` error (for both Flexible
 * and Uniform orchestration); the deploy then fails with
 * `ScaleSetAssignmentRejected`. Assign configurations to the individual
 * VMs with `VirtualMachineAssignment`, or through Azure Policy, instead.
 *
 * @see https://learn.microsoft.com/azure/governance/machine-configuration/overview
 *
 * ### Auditing a Baseline
 * **Example:** Audit the Azure Linux security baseline on a scale set
 * ```typescript
 * const scaleSet = yield* Azure.Compute.VirtualMachineScaleSet("Vmss", {
 *   resourceGroup: group.resourceGroupName,
 *   vmSize: "Standard_B1s",
 *   capacity: 2,
 *   subnetId: subnet.subnetId,
 *   adminUsername: "azureuser",
 *   sshPublicKeys: [publicKey],
 * });
 * const baseline =
 *   yield* Azure.GuestConfiguration.VirtualMachineScaleSetAssignment(
 *     "Baseline",
 *     {
 *       resourceGroup: group.resourceGroupName,
 *       virtualMachineScaleSet: scaleSet.virtualMachineScaleSetName,
 *       configurationName: "AzureLinuxBaseline",
 *       configurationVersion: "1.*",
 *     },
 *   );
 * ```
 *
 * ### Parameters
 * **Example:** Apply and monitor with configuration parameters
 * ```typescript
 * yield* Azure.GuestConfiguration.VirtualMachineScaleSetAssignment(
 *   "Baseline",
 *   {
 *     resourceGroup: group.resourceGroupName,
 *     virtualMachineScaleSet: scaleSet.virtualMachineScaleSetName,
 *     configurationName: "AzureLinuxBaseline",
 *     configurationVersion: "1.*",
 *     assignmentType: "ApplyAndMonitor",
 *     parameters: {
 *       "Ensure SSH root login is disabled;ExpectedValue": "true",
 *     },
 *   },
 * );
 * ```
 *
 * @resource
 */
export const VirtualMachineScaleSetAssignment =
  Resource<VirtualMachineScaleSetAssignment>(
    "Azure.GuestConfiguration.VirtualMachineScaleSetAssignment",
  );

/**
 * The service answers HTTP 200 with an embedded ARM error (e.g.
 * `VMSSNotSupported`) instead of a resource it cannot serve.
 */
export class ScaleSetAssignmentRejected extends Data.TaggedError(
  "Azure.GuestConfiguration.ScaleSetAssignmentRejected",
)<{
  readonly code: string | undefined;
  readonly message: string;
}> {}

/**
 * GET the assignment. An embedded error (no resource) means absent; the
 * scale set list endpoint is not served (404), so GET is the only probe.
 */
const getAssignment = (
  subscriptionId: string,
  resourceGroupName: string,
  vmssName: string,
  name: string,
) =>
  orUndefinedIfNotFound(
    guestconfiguration.GetGuestConfigurationAssignmentsVMSS({
      subscriptionId,
      resourceGroupName,
      vmssName,
      name,
    }),
  ).pipe(
    Effect.retry(whileLookupFails),
    Effect.map((assignment) =>
      assignment?.error === undefined ? assignment : undefined,
    ),
  );

const toAttrs = (
  resourceGroup: string,
  vmssName: string,
  name: string,
  location: string,
  configurationName: string,
  observed: guestconfiguration.GetGuestConfigurationAssignmentsVMSSResponse,
): VirtualMachineScaleSetAssignment["Attributes"] => ({
  ...toAssignmentAttrs(
    resourceGroup,
    name,
    location,
    configurationName,
    observed,
  ),
  virtualMachineScaleSet: vmssName,
  instances: (observed.properties?.vmssVMList ?? []).map((vm) => ({
    vmId: vm.vmId,
    vmResourceId: vm.vmResourceId,
    complianceStatus: vm.complianceStatus,
    latestReportId: vm.latestReportId ?? undefined,
  })),
});

export const VirtualMachineScaleSetAssignmentProvider = () =>
  Provider.succeed(VirtualMachineScaleSetAssignment, {
    stables: [
      "assignmentName",
      "assignmentId",
      "resourceGroup",
      "location",
      "configurationName",
      "virtualMachineScaleSet",
    ],

    // Assignments are deleted with their scale set; ARM only lists them
    // per scale set.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameId(news.virtualMachineScaleSet, output.virtualMachineScaleSet) ||
        assignmentReplaced(news, output)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const vmssName =
        output?.virtualMachineScaleSet ?? olds?.virtualMachineScaleSet;
      const name =
        output?.assignmentName ??
        (olds === undefined ? undefined : assignmentNameOf(olds));
      if (
        resourceGroup === undefined ||
        vmssName === undefined ||
        name === undefined
      ) {
        return undefined;
      }
      const observed = yield* getAssignment(
        subscriptionId,
        resourceGroup,
        vmssName,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(
        resourceGroup,
        vmssName,
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
      const vmssName = news.virtualMachineScaleSet;
      const name = assignmentNameOf(news);
      const location =
        news.location ??
        output?.location ??
        (yield* orUndefinedIfNotFound(
          compute.GetVirtualMachineScaleSet({
            subscriptionId,
            resourceGroupName: resourceGroup,
            vmScaleSetName: vmssName,
          }),
        ).pipe(Effect.map((set) => set?.location))) ??
        env.location;
      const get = getAssignment(subscriptionId, resourceGroup, vmssName, name);

      // Observe.
      const observed = yield* get;

      // Ensure, or re-PUT the full definition when anything drifted (no
      // PATCH exists).
      if (observed === undefined || assignmentDrifted(observed, news, olds)) {
        const response = yield* guestconfiguration
          .GuestConfigurationAssignmentsVMSSCreateOrUpdate({
            subscriptionId,
            resourceGroupName: resourceGroup,
            vmssName,
            name,
            location,
            properties: desiredProperties(news),
          })
          .pipe(Effect.retry(whileLookupFails));
        if (response.error !== undefined) {
          return yield* new ScaleSetAssignmentRejected({
            code: response.error.code,
            message:
              `Guest configuration rejected assignment ${name} on scale set ${vmssName}: ${response.error.code ?? "unknown"} ${response.error.message ?? ""}`.trim(),
          });
        }
      }
      const fresh = yield* waitForProvisioned(
        `guest configuration assignment ${name}`,
        get,
        assignmentState,
      );
      return toAttrs(
        resourceGroup,
        vmssName,
        name,
        location,
        news.configurationName,
        fresh,
      );
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        guestconfiguration.DeleteGuestConfigurationAssignmentsVMSS({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          vmssName: output.virtualMachineScaleSet,
          name: output.assignmentName,
        }),
      ).pipe(Effect.retry(whileLookupFails));
      yield* waitUntilGone(
        `guest configuration assignment ${output.assignmentName}`,
        getAssignment(
          subscriptionId,
          output.resourceGroup,
          output.virtualMachineScaleSet,
          output.assignmentName,
        ),
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Compute.VirtualMachineScaleSet",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
