import * as chaos from "@distilled.cloud/azure/chaos";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { parseTargetId, type TargetPath } from "./targetPath.ts";

export interface CapabilityProps {
  /**
   * ARM resource ID of the Chaos target the capability is enabled on
   * (`target.targetId`). Changing it replaces the capability.
   */
  targetId: string;
  /**
   * Capability type with version, which is also the capability's name, e.g.
   * `SecurityRule-1.1` (network security group), `Shutdown-2.0` (virtual
   * machine), or `CPUPressure-1.0` (agent). Changing it replaces the
   * capability.
   */
  capabilityType: string;
}

export interface Capability extends Resource<
  "Azure.Chaos.Capability",
  CapabilityProps,
  {
    /** ARM resource ID of the capability. */
    capabilityId: string;
    /** Name of the capability (its type with version, e.g. `SecurityRule-1.1`). */
    capabilityName: string;
    /** ARM resource ID of the Chaos target that holds the capability. */
    targetId: string;
    /** Fault URN; use it as the `name` of an experiment action. */
    urn: string;
    /** Publisher of the capability. */
    publisher: string | undefined;
    /** Target type the capability applies to. */
    targetType: string | undefined;
    /** Human-readable description of the fault. */
    description: string | undefined;
    /** URL of the JSON schema of the fault's action parameters. */
    parametersSchema: string | undefined;
  },
  never,
  Providers
> {}

/**
 * Enables a fault (capability) on an Azure Chaos Studio target.
 *
 * Experiments can only run faults whose capability is enabled on the
 * target. The capability's `urn` is the `name` of the experiment action
 * that runs the fault. Capabilities have no settings and no tags; deleting
 * the target deletes its capabilities.
 *
 * @see https://learn.microsoft.com/azure/chaos-studio/chaos-studio-fault-library
 *
 * ### Enabling a Fault
 * **Example:** Allow the NSG security-rule fault on a target
 * ```typescript
 * const target = yield* Azure.Chaos.Target("web-nsg-target", {
 *   parentResourceId: nsg.networkSecurityGroupId,
 *   targetType: "Microsoft-NetworkSecurityGroup",
 * });
 * const securityRule = yield* Azure.Chaos.Capability("security-rule", {
 *   targetId: target.targetId,
 *   capabilityType: "SecurityRule-1.1",
 * });
 * ```
 *
 * **Example:** Enable virtual machine shutdown
 * ```typescript
 * const shutdown = yield* Azure.Chaos.Capability("vm-shutdown", {
 *   targetId: vmTarget.targetId,
 *   capabilityType: "Shutdown-2.0",
 * });
 * ```
 *
 * @resource
 */
export const Capability = Resource<Capability>("Azure.Chaos.Capability");

const getCapability = (
  subscriptionId: string,
  path: TargetPath & { targetName: string },
  capabilityName: string,
) =>
  orUndefinedIfNotFound(
    chaos.GetCapability({
      subscriptionId,
      resourceGroupName: path.resourceGroupName,
      parentProviderNamespace: path.parentProviderNamespace,
      parentResourceType: path.parentResourceType,
      parentResourceName: path.parentResourceName,
      targetName: path.targetName,
      capabilityName,
    }),
  );

const toAttrs = (
  targetId: string,
  capabilityName: string,
  capability: chaos.Capability,
): Capability["Attributes"] => ({
  capabilityId: capability.id ?? `${targetId}/capabilities/${capabilityName}`,
  capabilityName: capability.name ?? capabilityName,
  targetId,
  urn: capability.properties?.urn ?? "",
  publisher: capability.properties?.publisher,
  targetType: capability.properties?.targetType,
  description: capability.properties?.description,
  parametersSchema: capability.properties?.parametersSchema,
});

export const CapabilityProvider = () =>
  Provider.succeed(Capability, {
    stables: ["capabilityId", "capabilityName", "targetId", "urn"],

    // Capabilities have no tags and are deleted with their target.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.targetId.toLowerCase() !== output.targetId.toLowerCase() ||
        news.capabilityType.toLowerCase() !==
          output.capabilityName.toLowerCase()
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const targetId = output?.targetId ?? olds?.targetId;
      const name = output?.capabilityName ?? olds?.capabilityType;
      // An interrupted create can persist props with unresolved holes.
      if (typeof targetId !== "string" || typeof name !== "string") {
        return undefined;
      }
      const path = yield* parseTargetId(targetId);
      const observed = yield* getCapability(subscriptionId, path, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(targetId, name, observed);
      // Capabilities carry no tags or markers: only a capability this stack
      // already recorded is known to be ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Chaos");
      const { targetId, capabilityType } = news;
      const path = yield* parseTargetId(targetId);

      // Observe.
      let observed: chaos.Capability | undefined = yield* getCapability(
        subscriptionId,
        path,
        capabilityType,
      );

      // Ensure. A capability has no mutable settings, so an existing one is
      // already converged.
      if (observed === undefined) {
        observed = yield* chaos.CapabilitiesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroupName,
          parentProviderNamespace: path.parentProviderNamespace,
          parentResourceType: path.parentResourceType,
          parentResourceName: path.parentResourceName,
          targetName: path.targetName,
          capabilityName: capabilityType,
          properties: {},
        });
      }

      return toAttrs(targetId, capabilityType, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const path = yield* parseTargetId(output.targetId);
      yield* ignoreNotFound(
        chaos.DeleteCapability({
          subscriptionId,
          resourceGroupName: path.resourceGroupName,
          parentProviderNamespace: path.parentProviderNamespace,
          parentResourceType: path.parentResourceType,
          parentResourceName: path.parentResourceName,
          targetName: path.targetName,
          capabilityName: output.capabilityName,
        }),
      );
      yield* waitUntilGone(
        `chaos capability ${output.capabilityName}`,
        getCapability(subscriptionId, path, output.capabilityName),
      );
    }),

    nuke: {
      dependsOn: ["Azure.Chaos.Target", "Azure.Resources.ResourceGroup"],
    },
  });
