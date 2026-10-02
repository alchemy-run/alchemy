import * as synapse from "@distilled.cloud/azure/synapse";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { ensureRegistered, orUndefinedIfNotFound } from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  fieldsMatch,
  isWorkspaceOwnedByStack,
  lower,
  resetSetting,
  sameSecret,
  secretFingerprint,
  syncSetting,
  type SecurityAlertPolicyFields,
  securityAlertProperties,
  unwrapSecret,
} from "./common.ts";

/** The policy is a singleton named `Default`. */
const POLICY_NAME = "Default";

export interface WorkspaceSecurityAlertPolicyProps extends SecurityAlertPolicyFields {
  /** Resource group of the workspace. Changing it replaces the policy. */
  resourceGroup: string;
  /** Name of the Synapse workspace. Changing it replaces the policy. */
  workspace: string;
}

export interface WorkspaceSecurityAlertPolicy extends Resource<
  "Azure.Synapse.WorkspaceSecurityAlertPolicy",
  WorkspaceSecurityAlertPolicyProps,
  {
    /** ARM resource ID of the policy. */
    policyId: string;
    /** Name of the workspace. */
    workspaceName: string;
    /** Resource group of the workspace. */
    resourceGroup: string;
    /** Whether threat detection is on. */
    state: string | undefined;
    /** Salted fingerprint of the last storage key Alchemy set. */
    keyFingerprint: Redacted.Redacted<string> | undefined;
  },
  never,
  Providers
> {}

/**
 * The threat detection (Microsoft Defender for SQL alerts) policy of a
 * Synapse workspace's SQL pools — alerts on SQL injection, anomalous
 * access, and data exfiltration. Enabling it turns on Microsoft Defender
 * for SQL, which is billed per workspace.
 *
 * This is a singleton policy that always exists on a workspace.
 * Destroying the resource disables threat detection.
 *
 * @see https://learn.microsoft.com/azure/azure-sql/database/threat-detection-configure
 *
 * ### Enabling Threat Detection
 * **Example:** Alert the security team
 * ```typescript
 * yield* Azure.Synapse.WorkspaceSecurityAlertPolicy("threats", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: workspace.workspaceName,
 *   emailAddresses: ["security@example.com"],
 * });
 * ```
 *
 * **Example:** Suppress one alert type
 * ```typescript
 * yield* Azure.Synapse.WorkspaceSecurityAlertPolicy("threats", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: workspace.workspaceName,
 *   disabledAlerts: ["Access_Anomaly"],
 * });
 * ```
 *
 * @resource
 */
export const WorkspaceSecurityAlertPolicy =
  Resource<WorkspaceSecurityAlertPolicy>(
    "Azure.Synapse.WorkspaceSecurityAlertPolicy",
  );

type ObservedPolicy =
  synapse.GetWorkspaceManagedSqlServerSecurityAlertPolicyResponse;

const getPolicy = (
  subscriptionId: string,
  resourceGroupName: string,
  workspaceName: string,
) =>
  orUndefinedIfNotFound(
    synapse.GetWorkspaceManagedSqlServerSecurityAlertPolicy({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      securityAlertPolicyName: POLICY_NAME,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  workspaceName: string,
  policy: ObservedPolicy,
  keyFingerprint: Redacted.Redacted<string> | undefined,
): WorkspaceSecurityAlertPolicy["Attributes"] => ({
  policyId: policy.id ?? "",
  workspaceName,
  resourceGroup,
  state: policy.properties?.state,
  keyFingerprint,
});

const settingSync = (
  subscriptionId: string,
  resourceGroup: string,
  workspace: string,
  desired: ReturnType<typeof securityAlertProperties> | { state: "Disabled" },
  storageAccountAccessKey: string | undefined,
) => ({
  label: `synapse workspace security alert policy on ${workspace}`,
  get: getPolicy(subscriptionId, resourceGroup, workspace),
  matches: (policy: ObservedPolicy) => fieldsMatch(policy.properties, desired),
  put: synapse.WorkspaceManagedSqlServerSecurityAlertPolicyCreateOrUpdate({
    subscriptionId,
    resourceGroupName: resourceGroup,
    workspaceName: workspace,
    securityAlertPolicyName: POLICY_NAME,
    properties: { ...desired, storageAccountAccessKey },
  }),
});

export const WorkspaceSecurityAlertPolicyProvider = () =>
  Provider.succeed(WorkspaceSecurityAlertPolicy, {
    stables: ["policyId", "workspaceName", "resourceGroup"],

    // A per-workspace singleton policy; it disappears with its workspace.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.workspace) !== lower(output.workspaceName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const workspace = output?.workspaceName ?? olds?.workspace;
      if (resourceGroup === undefined || workspace === undefined) {
        return undefined;
      }
      const observed = yield* getPolicy(
        subscriptionId,
        resourceGroup,
        workspace,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(
        resourceGroup,
        workspace,
        observed,
        output?.keyFingerprint,
      );
      return output !== undefined ||
        (yield* isWorkspaceOwnedByStack(
          subscriptionId,
          resourceGroup,
          workspace,
        ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Synapse");
      const { resourceGroup, workspace } = news;
      const fingerprint = yield* secretFingerprint(
        `${resourceGroup}/${workspace}/alerts`,
        news.storageAccountAccessKey,
      );
      const sync = settingSync(
        subscriptionId,
        resourceGroup,
        workspace,
        securityAlertProperties(news),
        unwrapSecret(news.storageAccountAccessKey),
      );
      // The key is write-only: re-send the policy when it changed.
      const observed = yield* sync.get;
      if (
        news.storageAccountAccessKey !== undefined &&
        !sameSecret(fingerprint, output?.keyFingerprint) &&
        observed !== undefined &&
        sync.matches(observed)
      ) {
        yield* sync.put;
      }
      const fresh = yield* syncSetting(sync);
      return toAttrs(resourceGroup, workspace, fresh, fingerprint);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      // The policy is never removed; disable threat detection.
      yield* resetSetting(
        settingSync(
          subscriptionId,
          output.resourceGroup,
          output.workspaceName,
          { state: "Disabled" },
          undefined,
        ),
      );
    }),

    nuke: { singleton: true },
  });
