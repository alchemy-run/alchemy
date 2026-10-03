import * as ml from "@distilled.cloud/azure/machinelearningservices";
import * as Effect from "effect/Effect";
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
  containsValue,
  createChildName,
  sameArm,
  sameValue,
  inputFields,
} from "./Common.ts";

export type OutboundRuleType = "FQDN" | "PrivateEndpoint" | "ServiceTag";

export interface PrivateEndpointDestination {
  /** ARM resource ID of the target resource (storage account, Key Vault, ...). */
  serviceResourceId: string;
  /** Sub-resource the private endpoint targets, e.g. `blob`, `vault`, `amlworkspace`. */
  subresourceTarget: string;
  /**
   * Allow Spark jobs to use the private endpoint.
   * @default false
   */
  sparkEnabled?: boolean;
}

export interface ServiceTagDestination {
  /** Azure service tag, e.g. `AzureMonitor`, `DataFactory`. */
  serviceTag: string;
  /** Protocol: `TCP`, `UDP`, `ICMP`, or `*`. */
  protocol: string;
  /** Port ranges, e.g. `"443"` or `"80,443"`. */
  portRanges: string;
  /**
   * Allow or deny the traffic.
   * @default "Allow"
   */
  action?: "Allow" | "Deny";
}

export interface OutboundRuleProps {
  /** Resource group of the workspace. Changing it replaces the rule. */
  resourceGroup: string;
  /** Workspace whose managed network holds the rule. Changing it replaces the rule. */
  workspace: string;
  /**
   * Rule name. If omitted, a unique name is generated from the logical ID.
   * Changing it replaces the rule.
   */
  name?: string;
  /**
   * Rule type. `FQDN` and `ServiceTag` rules need the workspace in
   * `AllowOnlyApprovedOutbound` mode; `PrivateEndpoint` rules work in
   * either managed-network mode. Changing it replaces the rule.
   */
  type: OutboundRuleType;
  /**
   * Destination: a host name for `FQDN`, a
   * {@link PrivateEndpointDestination} for `PrivateEndpoint`, a
   * {@link ServiceTagDestination} for `ServiceTag`. Azure rules are
   * immutable, so changing it replaces the rule.
   */
  destination: string | PrivateEndpointDestination | ServiceTagDestination;
  /**
   * Rule category. Changing it replaces the rule.
   * @default "UserDefined"
   */
  category?: "Required" | "Recommended" | "UserDefined" | "Dependency";
}

export interface OutboundRule extends Resource<
  "Azure.MachineLearning.OutboundRule",
  OutboundRuleProps,
  {
    /** Name of the rule. */
    ruleName: string;
    /** ARM resource ID of the rule. */
    ruleId: string;
    /** Workspace that holds the rule. */
    workspace: string;
    /** Resource group of the workspace. */
    resourceGroup: string;
    /** Rule type. */
    type: string;
    /** Rule category. */
    category: string | undefined;
    /** Rule status (`Inactive` until the managed network is provisioned). */
    status: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An outbound rule of an Azure Machine Learning workspace's managed
 * virtual network: a private endpoint to an Azure resource, an allowed
 * FQDN, or an allowed service tag.
 *
 * Rules are immutable: any change replaces the rule. They have no tags or
 * metadata, so ownership is tracked only in Alchemy state. A rule is
 * `Inactive` until the managed network is provisioned (when the first
 * compute is created).
 *
 * @see https://learn.microsoft.com/azure/machine-learning/how-to-managed-network
 *
 * ### Private Endpoints
 * **Example:** Private endpoint to a storage account
 * ```typescript
 * const workspace = yield* Azure.MachineLearning.Workspace("ws", {
 *   resourceGroup: group.resourceGroupName,
 *   kind: "Hub",
 *   storageAccount: storage.storageAccountId,
 *   keyVault: vault.vaultId,
 *   isolationMode: "AllowInternetOutbound",
 * });
 * const rule = yield* Azure.MachineLearning.OutboundRule("data", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: workspace.workspaceName,
 *   type: "PrivateEndpoint",
 *   destination: {
 *     serviceResourceId: data.storageAccountId,
 *     subresourceTarget: "blob",
 *   },
 * });
 * ```
 *
 * ### Allow-listing
 * **Example:** Allow an FQDN in approved-outbound mode
 * ```typescript
 * const rule = yield* Azure.MachineLearning.OutboundRule("pypi", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: workspace.workspaceName,
 *   type: "FQDN",
 *   destination: "pypi.org",
 * });
 * ```
 *
 * @resource
 */
export const OutboundRule = Resource<OutboundRule>(
  "Azure.MachineLearning.OutboundRule",
);

const getRule = (
  subscriptionId: string,
  resourceGroupName: string,
  workspaceName: string,
  ruleName: string,
) =>
  orUndefinedIfNotFound(
    ml.GetManagedNetworkSettingsRule({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      ruleName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  workspace: string,
  name: string,
  rule: ml.GetManagedNetworkSettingsRuleResponse,
): OutboundRule["Attributes"] => ({
  ruleName: name,
  ruleId: rule.id ?? "",
  workspace,
  resourceGroup,
  type: rule.properties.type,
  category: rule.properties.category,
  status: rule.properties.status,
});

const desiredDestination = (
  destination: OutboundRuleProps["destination"],
): unknown =>
  typeof destination === "string"
    ? destination
    : "serviceResourceId" in destination
      ? { sparkEnabled: false, ...destination }
      : { action: "Allow", ...destination };

export const OutboundRuleProvider = () =>
  Provider.succeed(OutboundRule, {
    stables: ["ruleName", "ruleId", "workspace", "resourceGroup", "type"],

    // Rules are deleted with their workspace.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (output === undefined) return undefined;
      // Parent names are stable upstream; an unresolved one means the
      // parent is being replaced.
      const fields = inputFields(news);
      if (
        fields === undefined ||
        !isResolved(fields.resourceGroup) ||
        !isResolved(fields.workspace)
      ) {
        return { action: "replace" } as const;
      }
      if (!isResolved(news)) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        !sameArm(news.workspace, output.workspace) ||
        (news.name !== undefined && news.name !== output.ruleName) ||
        !sameArm(news.type, output.type) ||
        (olds !== undefined &&
          (!sameValue(
            desiredDestination(news.destination),
            desiredDestination(olds.destination),
          ) ||
            (news.category ?? "UserDefined") !==
              (olds.category ?? "UserDefined")))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const workspace = output?.workspace ?? olds?.workspace;
      if (resourceGroup === undefined || workspace === undefined) {
        return undefined;
      }
      const name =
        output?.ruleName ?? olds?.name ?? (yield* createChildName(id, 64));
      const observed = yield* getRule(
        subscriptionId,
        resourceGroup,
        workspace,
        name,
      );
      // No tags or metadata: the deterministic name is the only ownership
      // signal, so an existing rule under it is ours.
      return observed === undefined
        ? undefined
        : toAttrs(resourceGroup, workspace, name, observed);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(
        subscriptionId,
        "Microsoft.MachineLearningServices",
      );
      const { resourceGroup, workspace } = news;
      const name =
        news.name ?? output?.ruleName ?? (yield* createChildName(id, 64));
      const destination = desiredDestination(news.destination);
      const category = news.category ?? "UserDefined";
      const get = getRule(subscriptionId, resourceGroup, workspace, name);
      const converged = (rule: ml.GetManagedNetworkSettingsRuleResponse) =>
        sameArm(rule.properties.category, category) &&
        containsValue(rule.properties.destination, destination);

      // Observe.
      const observed = yield* get;

      // Ensure. Rules are immutable (changes replace them in diff), so the
      // PUT is only sent when the rule is missing.
      if (observed === undefined) {
        yield* ml.ManagedNetworkSettingsRuleCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          workspaceName: workspace,
          ruleName: name,
          properties: { type: news.type, category, destination },
        });
      }

      const fresh = yield* waitForProvisioned(
        `machine learning outbound rule ${name}`,
        get,
        (rule) =>
          rule.properties.status === "Failed"
            ? "Failed"
            : converged(rule)
              ? "Succeeded"
              : "Updating",
        { interval: "5 seconds", times: 72 },
      );
      return toAttrs(resourceGroup, workspace, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        ml.DeleteManagedNetworkSettingsRule({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          workspaceName: output.workspace,
          ruleName: output.ruleName,
        }),
      );
      yield* waitUntilGone(
        `machine learning outbound rule ${output.ruleName}`,
        getRule(
          subscriptionId,
          output.resourceGroup,
          output.workspace,
          output.ruleName,
        ),
        { interval: "5 seconds", times: 72 },
      );
    }),

    nuke: { dependsOn: ["Azure.MachineLearning.Workspace"] },
  });
