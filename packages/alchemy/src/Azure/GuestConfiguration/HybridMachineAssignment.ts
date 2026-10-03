import * as guestconfiguration from "@distilled.cloud/azure/guestconfiguration";
import * as hybridcompute from "@distilled.cloud/azure/hybridcompute";
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

export interface HybridMachineAssignmentProps extends AssignmentProps {
  /**
   * Name of the Azure Arc-enabled server the configuration is assigned to.
   * Changing it replaces the assignment.
   */
  machine: string;
}

export interface HybridMachineAssignment extends Resource<
  "Azure.GuestConfiguration.HybridMachineAssignment",
  HybridMachineAssignmentProps,
  AssignmentAttributes & {
    /** Name of the Arc-enabled server. */
    machine: string;
  },
  never,
  Providers
> {}

/**
 * A machine configuration (guest configuration) assignment on an Azure
 * Arc-enabled server — audits or applies an OS-level configuration package
 * such as the built-in Linux/Windows security baselines on a machine
 * outside Azure.
 *
 * Compliance is evaluated by the Connected Machine agent; on a machine
 * whose agent has not connected yet the assignment stays `Pending`.
 *
 * @see https://learn.microsoft.com/azure/governance/machine-configuration/overview
 *
 * ### Auditing a Baseline
 * **Example:** Audit the Azure Linux security baseline on a connected Arc server
 * ```typescript
 * const baseline = yield* Azure.GuestConfiguration.HybridMachineAssignment(
 *   "Baseline",
 *   {
 *     resourceGroup: "arc-servers",
 *     machine: "web-01",
 *     configurationName: "AzureLinuxBaseline",
 *     configurationVersion: "1.*",
 *   },
 * );
 * ```
 *
 * ### Parameters
 * **Example:** Apply and monitor with configuration parameters
 * ```typescript
 * yield* Azure.GuestConfiguration.HybridMachineAssignment("Baseline", {
 *   resourceGroup: "arc-servers",
 *   machine: "web-01",
 *   configurationName: "AzureLinuxBaseline",
 *   configurationVersion: "1.*",
 *   assignmentType: "ApplyAndMonitor",
 *   parameters: { "Ensure SSH root login is disabled;ExpectedValue": "true" },
 * });
 * ```
 *
 * @resource
 */
export const HybridMachineAssignment = Resource<HybridMachineAssignment>(
  "Azure.GuestConfiguration.HybridMachineAssignment",
);

/**
 * Observe through the list endpoint, retrying while the service fails to
 * look up the machine (`GuestConfigurationMachineInfoUnavailable`).
 */
const getAssignment = (
  subscriptionId: string,
  resourceGroupName: string,
  machineName: string,
  name: string,
) =>
  orUndefinedIfNotFound(
    guestconfiguration.ListGuestConfigurationHCRPAssignments({
      subscriptionId,
      resourceGroupName,
      machineName,
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
  machineName: string,
  name: string,
  location: string,
  configurationName: string,
  observed: guestconfiguration.GuestConfigurationAssignment,
): HybridMachineAssignment["Attributes"] => ({
  ...toAssignmentAttrs(
    resourceGroup,
    name,
    location,
    configurationName,
    observed,
  ),
  machine: machineName,
});

export const HybridMachineAssignmentProvider = () =>
  Provider.succeed(HybridMachineAssignment, {
    stables: [
      "assignmentName",
      "assignmentId",
      "resourceGroup",
      "location",
      "configurationName",
      "machine",
    ],

    // Assignments are deleted with their machine; ARM only lists them per
    // machine.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameId(news.machine, output.machine) ||
        assignmentReplaced(news, output)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const machineName = output?.machine ?? olds?.machine;
      const name =
        output?.assignmentName ??
        (olds === undefined ? undefined : assignmentNameOf(olds));
      if (
        resourceGroup === undefined ||
        machineName === undefined ||
        name === undefined
      ) {
        return undefined;
      }
      const observed = yield* getAssignment(
        subscriptionId,
        resourceGroup,
        machineName,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(
        resourceGroup,
        machineName,
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
      const machineName = news.machine;
      const name = assignmentNameOf(news);
      const location =
        news.location ??
        output?.location ??
        (yield* orUndefinedIfNotFound(
          hybridcompute.GetMachine({
            subscriptionId,
            resourceGroupName: resourceGroup,
            machineName,
          }),
        ).pipe(Effect.map((vm) => vm?.location))) ??
        env.location;
      const get = getAssignment(
        subscriptionId,
        resourceGroup,
        machineName,
        name,
      );

      // Observe.
      const observed = yield* get;

      // Ensure, or re-PUT the full definition when anything drifted (no
      // PATCH exists).
      if (observed === undefined || assignmentDrifted(observed, news, olds)) {
        yield* guestconfiguration
          .GuestConfigurationHCRPAssignmentsCreateOrUpdate({
            subscriptionId,
            resourceGroupName: resourceGroup,
            machineName,
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
        machineName,
        name,
        location,
        news.configurationName,
        fresh,
      );
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        guestconfiguration.DeleteGuestConfigurationHCRPAssignment({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          machineName: output.machine,
          guestConfigurationAssignmentName: output.assignmentName,
        }),
      ).pipe(Effect.retry(whileLookupFails));
      yield* waitUntilGone(
        `guest configuration assignment ${output.assignmentName}`,
        getAssignment(
          subscriptionId,
          output.resourceGroup,
          output.machine,
          output.assignmentName,
        ),
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.HybridCompute.Machine",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
