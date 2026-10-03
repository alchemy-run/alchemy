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
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { DEVTESTLAB_NAMESPACE, diverges, labLocation } from "./Common.ts";

export type PolicyFactName =
  | "UserOwnedLabVmCount"
  | "UserOwnedLabPremiumVmCount"
  | "LabVmCount"
  | "LabPremiumVmCount"
  | "LabVmSize"
  | "GalleryImage"
  | "UserOwnedLabVmCountInSubnet"
  | "LabTargetCost"
  | "EnvironmentTemplate"
  | "ScheduleEditPermission";

export interface PolicyProps {
  /** Resource group of the lab. Changing it replaces the policy. */
  resourceGroup: string;
  /** Name of the lab. Changing it replaces the policy. */
  lab: string;
  /** Fact the policy evaluates. Changing it replaces the policy. */
  factName: PolicyFactName;
  /**
   * How `threshold` is evaluated: a maximum (`MaxValuePolicy`) or a set of
   * allowed values (`AllowedValuesPolicy`). Changing it replaces the
   * policy.
   */
  evaluatorType: "AllowedValuesPolicy" | "MaxValuePolicy";
  /**
   * Threshold: a number for `MaxValuePolicy` (e.g. `"5"`), or a JSON array
   * string of allowed values for `AllowedValuesPolicy` (e.g.
   * `'["Standard_B1s"]'`).
   */
  threshold: string;
  /**
   * Policy name. Labs look policies up by fact, so the name defaults to
   * `factName`. Changing it replaces the policy.
   */
  name?: string;
  /** Extra fact data, e.g. the subnet for `UserOwnedLabVmCountInSubnet`. */
  factData?: string;
  /**
   * Whether the policy is enforced.
   * @default "Enabled"
   */
  status?: "Enabled" | "Disabled";
  /** Description of the policy. */
  description?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Policy extends Resource<
  "Azure.DevTestLabs.Policy",
  PolicyProps,
  {
    /** Name of the policy. */
    policyName: string;
    /** ARM resource ID of the policy. */
    policyId: string;
    /** Resource group of the lab. */
    resourceGroup: string;
    /** Name of the lab. */
    lab: string;
    /** Fact the policy evaluates. */
    factName: string;
    /** Evaluator of the threshold. */
    evaluatorType: string;
    /** Current threshold. */
    threshold: string | undefined;
    /** Whether the policy is enforced. */
    status: string | undefined;
    /** Unique immutable identifier (GUID) of the policy. */
    uniqueIdentifier: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A DevTest Labs policy — a limit or allow-list (VM count, VM sizes,
 * gallery images, ...) enforced in the lab's `default` policy set.
 *
 * @see https://learn.microsoft.com/azure/devtest-labs/devtest-lab-set-lab-policy
 *
 * ### Limits
 * **Example:** At most 5 VMs per lab
 * ```typescript
 * const vmCount = yield* Azure.DevTestLabs.Policy("vm-count", {
 *   resourceGroup: group.resourceGroupName,
 *   lab: lab.labName,
 *   factName: "LabVmCount",
 *   evaluatorType: "MaxValuePolicy",
 *   threshold: "5",
 * });
 * ```
 *
 * ### Allow-lists
 * **Example:** Allowed VM sizes
 * ```typescript
 * const sizes = yield* Azure.DevTestLabs.Policy("vm-sizes", {
 *   resourceGroup: group.resourceGroupName,
 *   lab: lab.labName,
 *   factName: "LabVmSize",
 *   evaluatorType: "AllowedValuesPolicy",
 *   threshold: JSON.stringify(["Standard_B1s", "Standard_B2s"]),
 * });
 * ```
 *
 * @resource
 */
export const Policy = Resource<Policy>("Azure.DevTestLabs.Policy");

const POLICY_SET = "default";

const getPolicy = (
  subscriptionId: string,
  resourceGroupName: string,
  labName: string,
  name: string,
) =>
  orUndefinedIfNotFound(
    devtestlabs.GetPolicy({
      subscriptionId,
      resourceGroupName,
      labName,
      policySetName: POLICY_SET,
      name,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  lab: string,
  name: string,
  p: devtestlabs.GetPolicyResponse,
): Policy["Attributes"] => ({
  policyName: name,
  policyId: p.id ?? "",
  resourceGroup,
  lab,
  factName: p.properties?.factName ?? "",
  evaluatorType: p.properties?.evaluatorType ?? "",
  threshold: p.properties?.threshold,
  status: p.properties?.status,
  uniqueIdentifier: p.properties?.uniqueIdentifier,
  tags: userTags(p.tags),
});

export const PolicyProvider = () =>
  Provider.succeed(Policy, {
    stables: ["policyName", "policyId", "resourceGroup", "lab", "factName"],

    // Policies are deleted with their lab.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.lab.toLowerCase() !== output.lab.toLowerCase() ||
        news.factName !== output.factName ||
        news.evaluatorType !== output.evaluatorType ||
        (news.name ?? news.factName).toLowerCase() !==
          output.policyName.toLowerCase()
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const lab = output?.lab ?? olds?.lab;
      const name = output?.policyName ?? olds?.name ?? olds?.factName;
      if (
        resourceGroup === undefined ||
        lab === undefined ||
        name === undefined
      ) {
        return undefined;
      }
      const observed = yield* getPolicy(subscriptionId, resourceGroup, lab, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, lab, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, DEVTESTLAB_NAMESPACE);
      const { resourceGroup, lab } = news;
      const name = news.name ?? output?.policyName ?? news.factName;
      const tags = yield* desiredTags(id, news.tags);
      const properties: devtestlabs.PolicyPropertiesInput = {
        factName: news.factName,
        evaluatorType: news.evaluatorType,
        threshold: news.threshold,
        factData: news.factData,
        status: news.status ?? "Enabled",
        description: news.description,
      };

      // Observe.
      let observed = yield* getPolicy(subscriptionId, resourceGroup, lab, name);

      // Ensure + sync: the PUT is a synchronous full upsert.
      if (
        observed === undefined ||
        diverges(properties, observed.properties) ||
        tagsDiffer(observed.tags, tags)
      ) {
        observed = yield* devtestlabs.PoliciesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          labName: lab,
          policySetName: POLICY_SET,
          name,
          location:
            observed?.location ??
            (yield* labLocation(subscriptionId, resourceGroup, lab)),
          tags,
          properties,
        });
      }

      return toAttrs(resourceGroup, lab, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        devtestlabs.DeletePolicy({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          labName: output.lab,
          policySetName: POLICY_SET,
          name: output.policyName,
        }),
      );
      yield* waitUntilGone(
        `lab policy ${output.policyName}`,
        getPolicy(
          subscriptionId,
          output.resourceGroup,
          output.lab,
          output.policyName,
        ),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
