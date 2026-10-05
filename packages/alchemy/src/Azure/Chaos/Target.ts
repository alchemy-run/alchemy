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
import { canonical, parseParentId, type TargetPath } from "./targetPath.ts";

export interface TargetProps {
  /**
   * ARM resource ID of the resource to onboard to Chaos Studio, e.g. a
   * network security group, virtual machine, Key Vault, or Cosmos DB account.
   * Must be a top-level resource. Changing it replaces the target.
   */
  parentResourceId: string;
  /**
   * Chaos target type, which is also the target's name, e.g.
   * `Microsoft-NetworkSecurityGroup`, `Microsoft-VirtualMachine`,
   * `Microsoft-KeyVault`, or `Microsoft-Agent`. Changing it replaces the
   * target.
   */
  targetType: string;
  /**
   * Target-type specific properties. Service-direct targets take `{}`;
   * agent-based targets (`Microsoft-Agent`) take `identities` and similar
   * settings.
   * @default {}
   */
  properties?: Record<string, unknown>;
  /**
   * Location of the target. Omit to let Chaos Studio use the parent's
   * location. Changing it replaces the target.
   */
  location?: string;
}

export interface Target extends Resource<
  "Azure.Chaos.Target",
  TargetProps,
  {
    /** ARM resource ID of the target; reference it from experiment selectors. */
    targetId: string;
    /** Name of the target (its target type, e.g. `Microsoft-NetworkSecurityGroup`). */
    targetName: string;
    /** ARM resource ID of the onboarded resource. */
    parentResourceId: string;
    /** Resource group of the onboarded resource. */
    resourceGroup: string;
    /** Location of the target, when Chaos Studio reports one. */
    location: string | undefined;
    /** Target-type specific properties as observed. */
    properties: Record<string, unknown>;
  },
  never,
  Providers
> {}

/**
 * Onboards an Azure resource to Azure Chaos Studio as a chaos target.
 *
 * A target is an extension resource on the onboarded resource
 * (`{parent}/providers/Microsoft.Chaos/targets/{targetType}`). Enable faults
 * on it with {@link Capability} children, then reference its `targetId` in an
 * {@link Experiment} selector. Targets cannot be tagged; deleting the parent
 * resource deletes its targets.
 *
 * @see https://learn.microsoft.com/azure/chaos-studio/chaos-studio-targets-capabilities
 *
 * ### Onboarding a Resource
 * **Example:** Service-direct target on a network security group
 * ```typescript
 * const nsg = yield* Azure.Network.NetworkSecurityGroup("web-nsg", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const target = yield* Azure.Chaos.Target("web-nsg-target", {
 *   parentResourceId: nsg.networkSecurityGroupId,
 *   targetType: "Microsoft-NetworkSecurityGroup",
 * });
 * ```
 *
 * **Example:** Agent-based target on a virtual machine
 * ```typescript
 * const target = yield* Azure.Chaos.Target("vm-agent", {
 *   parentResourceId: vm.virtualMachineId,
 *   targetType: "Microsoft-Agent",
 *   properties: {
 *     identities: [{ type: "AzureManagedIdentity", clientId: identity.clientId }],
 *   },
 * });
 * ```
 *
 * @resource
 */
export const Target = Resource<Target>("Azure.Chaos.Target");

const getTarget = (
  subscriptionId: string,
  path: TargetPath,
  targetName: string,
) =>
  orUndefinedIfNotFound(
    chaos.GetTarget({ subscriptionId, ...path, targetName }),
  );

const toAttrs = (
  parentResourceId: string,
  path: TargetPath,
  targetName: string,
  target: chaos.Target,
): Target["Attributes"] => ({
  targetId:
    target.id ??
    `${parentResourceId}/providers/Microsoft.Chaos/targets/${targetName}`,
  targetName: target.name ?? targetName,
  parentResourceId,
  resourceGroup: path.resourceGroupName,
  location: target.location,
  properties: (target.properties ?? {}) as Record<string, unknown>,
});

export const TargetProvider = () =>
  Provider.succeed(Target, {
    stables: ["targetId", "targetName", "parentResourceId", "resourceGroup"],

    // Targets are extension resources without tags and are deleted with
    // their parent; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.parentResourceId.toLowerCase() !==
          output.parentResourceId.toLowerCase() ||
        news.targetType.toLowerCase() !== output.targetName.toLowerCase() ||
        (news.location !== undefined &&
          news.location.toLowerCase() !== (output.location ?? "").toLowerCase())
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const parentResourceId =
        output?.parentResourceId ?? olds?.parentResourceId;
      const targetName = output?.targetName ?? olds?.targetType;
      // An interrupted create can persist props with unresolved holes.
      if (
        typeof parentResourceId !== "string" ||
        typeof targetName !== "string"
      ) {
        return undefined;
      }
      const path = yield* parseParentId(parentResourceId);
      const observed = yield* getTarget(subscriptionId, path, targetName);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(parentResourceId, path, targetName, observed);
      // Targets carry no tags or markers: only a target this stack already
      // recorded is known to be ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Chaos");
      const { parentResourceId, targetType } = news;
      const path = yield* parseParentId(parentResourceId);
      const properties = news.properties ?? {};

      // Observe.
      let observed: chaos.Target | undefined = yield* getTarget(
        subscriptionId,
        path,
        targetType,
      );

      // Ensure + sync properties: the PUT is a synchronous upsert and the
      // properties map is the only mutable aspect.
      if (
        observed === undefined ||
        canonical(observed.properties ?? {}) !== canonical(properties)
      ) {
        observed = yield* chaos.TargetsCreateOrUpdate({
          subscriptionId,
          ...path,
          targetName: targetType,
          properties,
          ...(news.location !== undefined ? { location: news.location } : {}),
        });
      }

      return toAttrs(parentResourceId, path, targetType, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const path = yield* parseParentId(output.parentResourceId);
      yield* ignoreNotFound(
        chaos.DeleteTarget({
          subscriptionId,
          ...path,
          targetName: output.targetName,
        }),
      );
      yield* waitUntilGone(
        `chaos target ${output.targetName}`,
        getTarget(subscriptionId, path, output.targetName),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
