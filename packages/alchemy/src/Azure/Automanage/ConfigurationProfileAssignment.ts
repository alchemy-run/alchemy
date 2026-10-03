import * as automanage from "@distilled.cloud/azure/automanage";
import * as compute from "@distilled.cloud/azure/compute";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import {
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  orUndefinedIfNotFound,
  resourceGroupOf,
  stackAndStage,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

/** Azure only supports one assignment per machine, named `default`. */
const ASSIGNMENT_NAME = "default";

export interface ConfigurationProfileAssignmentProps {
  /**
   * Resource group of the target virtual machine. Changing it replaces the
   * assignment.
   */
  resourceGroup: string;
  /**
   * Name of the target virtual machine. Changing it replaces the
   * assignment.
   */
  virtualMachine: string;
  /**
   * ARM resource ID of the configuration profile to apply: a custom
   * `ConfigurationProfile` ID, or a built-in best-practices profile
   * (`/providers/Microsoft.Automanage/bestPractices/AzureBestPracticesProduction`
   * or `.../AzureBestPracticesDevTest`). Updated in place.
   */
  configurationProfile: string;
}

export interface ConfigurationProfileAssignment extends Resource<
  "Azure.Automanage.ConfigurationProfileAssignment",
  ConfigurationProfileAssignmentProps,
  {
    /** Name of the assignment (always `default`). */
    assignmentName: string;
    /** Resource group of the target virtual machine. */
    resourceGroup: string;
    /** Name of the target virtual machine. */
    virtualMachine: string;
    /** ARM resource ID of the assignment. */
    assignmentId: string;
    /** ARM resource ID of the assigned configuration profile. */
    configurationProfile: string;
    /** ARM resource ID of the target virtual machine. */
    targetId: string | undefined;
    /**
     * Onboarding status reported by Automanage (e.g. `InProgress`,
     * `Conformant`, `NotConformant`). Converges asynchronously.
     */
    status: string | undefined;
  },
  never,
  Providers
> {}

/**
 * Assigns an Azure Automanage configuration profile to a virtual machine,
 * onboarding the machine to the profile's best-practice services.
 *
 * A machine holds at most one assignment. The assignment has no tags;
 * Alchemy treats it as owned when its virtual machine carries this stack's
 * ownership tags. Onboarding (extensions, backup, monitoring) converges in
 * the background after the assignment is created; the resource does not
 * wait for the machine to become `Conformant`.
 *
 * @see https://learn.microsoft.com/azure/automanage/overview-about
 *
 * ### Assigning a Profile
 * **Example:** Assign a custom profile to a VM
 * ```typescript
 * const profile = yield* Azure.Automanage.ConfigurationProfile("baseline", {
 *   resourceGroup: group.resourceGroupName,
 *   configuration: { "AzureSecurityBaseline/Enable": true },
 * });
 * yield* Azure.Automanage.ConfigurationProfileAssignment("vm-profile", {
 *   resourceGroup: group.resourceGroupName,
 *   virtualMachine: vm.virtualMachineName,
 *   configurationProfile: profile.configurationProfileId,
 * });
 * ```
 *
 * **Example:** Assign the built-in dev/test best practices
 * ```typescript
 * yield* Azure.Automanage.ConfigurationProfileAssignment("vm-devtest", {
 *   resourceGroup: group.resourceGroupName,
 *   virtualMachine: vm.virtualMachineName,
 *   configurationProfile:
 *     "/providers/Microsoft.Automanage/bestPractices/AzureBestPracticesDevTest",
 * });
 * ```
 *
 * @resource
 */
export const ConfigurationProfileAssignment =
  Resource<ConfigurationProfileAssignment>(
    "Azure.Automanage.ConfigurationProfileAssignment",
  );

type ObservedAssignment = automanage.GetConfigurationProfileAssignmentResponse;

const getAssignment = (
  subscriptionId: string,
  resourceGroupName: string,
  vmName: string,
) =>
  orUndefinedIfNotFound(
    automanage.GetConfigurationProfileAssignment({
      subscriptionId,
      resourceGroupName,
      vmName,
      configurationProfileAssignmentName: ASSIGNMENT_NAME,
    }),
  );

const getVmTags = (
  subscriptionId: string,
  resourceGroupName: string,
  vmName: string,
) =>
  orUndefinedIfNotFound(
    compute.GetVirtualMachine({ subscriptionId, resourceGroupName, vmName }),
  ).pipe(Effect.map((vm) => vm?.tags));

/** Owned when the target VM carries this stack's ownership tags. */
const vmOwnedByStack = Effect.fn(function* (
  tags: Record<string, string | undefined> | undefined,
) {
  const { stack, stage } = yield* stackAndStage;
  const record = tagRecord(tags);
  return (
    record["alchemy::stack"] === stack && record["alchemy::stage"] === stage
  );
});

const toAttrs = (
  resourceGroup: string,
  vmName: string,
  assignment: ObservedAssignment,
): ConfigurationProfileAssignment["Attributes"] => ({
  assignmentName: ASSIGNMENT_NAME,
  resourceGroup,
  virtualMachine: vmName,
  assignmentId: assignment.id ?? "",
  configurationProfile: assignment.properties?.configurationProfile ?? "",
  targetId: assignment.properties?.targetId,
  status: assignment.properties?.status,
});

const sameId = (a: string | undefined, b: string | undefined) =>
  (a ?? "").toLowerCase() === (b ?? "").toLowerCase();

export const ConfigurationProfileAssignmentProvider = () =>
  Provider.succeed(ConfigurationProfileAssignment, {
    stables: [
      "assignmentName",
      "resourceGroup",
      "virtualMachine",
      "assignmentId",
      "targetId",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page =
        yield* automanage.ListConfigurationProfileAssignmentBySubscription({
          subscriptionId,
        });
      const results: ConfigurationProfileAssignment["Attributes"][] = [];
      for (const assignment of page.value ?? []) {
        // Only VM assignments: `.../virtualMachines/<vm>/providers/...`.
        const vmName = assignment.id?.match(
          /\/providers\/Microsoft\.Compute\/virtualMachines\/([^/]+)\//i,
        )?.[1];
        const group = resourceGroupOf(assignment.id);
        if (vmName === undefined || group === undefined) continue;
        const tags = yield* getVmTags(subscriptionId, group, vmName);
        if (hasAnyAlchemyTag(tags)) {
          results.push(toAttrs(group, vmName, assignment));
        }
      }
      return results;
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.virtualMachine.toLowerCase() !==
          output.virtualMachine.toLowerCase()
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const vmName = output?.virtualMachine ?? olds?.virtualMachine;
      if (resourceGroup === undefined || vmName === undefined) return undefined;
      const observed = yield* getAssignment(
        subscriptionId,
        resourceGroup,
        vmName,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, vmName, observed);
      const tags = yield* getVmTags(subscriptionId, resourceGroup, vmName);
      return (yield* vmOwnedByStack(tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Automanage");
      const resourceGroup = news.resourceGroup;
      const vmName = news.virtualMachine;

      // Observe.
      let observed = yield* getAssignment(
        subscriptionId,
        resourceGroup,
        vmName,
      );

      // Ensure + sync the profile reference (PUT is a full upsert).
      if (
        observed === undefined ||
        !sameId(
          observed.properties?.configurationProfile,
          news.configurationProfile,
        )
      ) {
        yield* automanage.ConfigurationProfileAssignmentsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          vmName,
          configurationProfileAssignmentName: ASSIGNMENT_NAME,
          properties: { configurationProfile: news.configurationProfile },
        });
        // Block until the assignment is readable and references the
        // desired profile; onboarding status converges in the background.
        observed = yield* waitForProvisioned(
          `Automanage assignment on ${vmName}`,
          getAssignment(subscriptionId, resourceGroup, vmName).pipe(
            Effect.map((a) =>
              a !== undefined &&
              sameId(
                a.properties?.configurationProfile,
                news.configurationProfile,
              )
                ? a
                : undefined,
            ),
          ),
          () => undefined,
        );
      }

      return toAttrs(resourceGroup, vmName, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        automanage.DeleteConfigurationProfileAssignment({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          vmName: output.virtualMachine,
          configurationProfileAssignmentName: ASSIGNMENT_NAME,
        }),
      );
      yield* waitUntilGone(
        `Automanage assignment on ${output.virtualMachine}`,
        getAssignment(
          subscriptionId,
          output.resourceGroup,
          output.virtualMachine,
        ),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Compute.VirtualMachine",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
