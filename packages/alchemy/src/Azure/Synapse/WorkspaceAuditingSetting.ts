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
  type AuditingSettingFields,
  auditingProperties,
  fieldsMatch,
  isWorkspaceOwnedByStack,
  lower,
  resetSetting,
  sameSecret,
  secretFingerprint,
  syncSetting,
  unwrapSecret,
} from "./common.ts";

/** The policy is a singleton named `default`. */
const POLICY_NAME = "default";

export interface WorkspaceAuditingSettingProps extends AuditingSettingFields {
  /** Resource group of the workspace. Changing it replaces the setting. */
  resourceGroup: string;
  /** Name of the Synapse workspace. Changing it replaces the setting. */
  workspace: string;
  /** Also audit Microsoft support operations (DevOps auditing). */
  isDevopsAuditEnabled?: boolean;
}

export interface WorkspaceAuditingSetting extends Resource<
  "Azure.Synapse.WorkspaceAuditingSetting",
  WorkspaceAuditingSettingProps,
  {
    /** ARM resource ID of the policy. */
    settingId: string;
    /** Name of the workspace. */
    workspaceName: string;
    /** Resource group of the workspace. */
    resourceGroup: string;
    /** Whether auditing is enabled. */
    state: string | undefined;
    /** Audit storage endpoint. */
    storageEndpoint: string | undefined;
    /** Whether Azure Monitor is an audit target. */
    isAzureMonitorTargetEnabled: boolean | undefined;
    /** Salted fingerprint of the last storage key Alchemy set. */
    keyFingerprint: Redacted.Redacted<string> | undefined;
  },
  never,
  Providers
> {}

/**
 * Blob auditing for every SQL pool of a Synapse workspace — writes audit
 * logs to a storage account, Log Analytics, or Event Hubs (via Azure
 * Monitor).
 *
 * This is a singleton policy that always exists on a workspace.
 * Destroying the resource disables auditing.
 *
 * @see https://learn.microsoft.com/azure/azure-sql/database/auditing-overview
 *
 * ### Enabling Auditing
 * **Example:** Audit to Azure Monitor
 * ```typescript
 * yield* Azure.Synapse.WorkspaceAuditingSetting("audit", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: workspace.workspaceName,
 *   isAzureMonitorTargetEnabled: true,
 * });
 * ```
 *
 * **Example:** Audit to a storage account with the workspace identity
 * ```typescript
 * yield* Azure.Synapse.WorkspaceAuditingSetting("audit", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: workspace.workspaceName,
 *   storageEndpoint: auditAccount.primaryEndpoints.blob.as<string>(),
 *   retentionDays: 90,
 * });
 * ```
 *
 * @resource
 */
export const WorkspaceAuditingSetting = Resource<WorkspaceAuditingSetting>(
  "Azure.Synapse.WorkspaceAuditingSetting",
);

type ObservedPolicy =
  synapse.GetWorkspaceManagedSqlServerBlobAuditingPolicyResponse;

const getPolicy = (
  subscriptionId: string,
  resourceGroupName: string,
  workspaceName: string,
) =>
  orUndefinedIfNotFound(
    synapse.GetWorkspaceManagedSqlServerBlobAuditingPolicy({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      blobAuditingPolicyName: POLICY_NAME,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  workspaceName: string,
  policy: ObservedPolicy,
  keyFingerprint: Redacted.Redacted<string> | undefined,
): WorkspaceAuditingSetting["Attributes"] => ({
  settingId: policy.id ?? "",
  workspaceName,
  resourceGroup,
  state: policy.properties?.state,
  storageEndpoint: policy.properties?.storageEndpoint,
  isAzureMonitorTargetEnabled: policy.properties?.isAzureMonitorTargetEnabled,
  keyFingerprint,
});

const settingSync = (
  subscriptionId: string,
  resourceGroup: string,
  workspace: string,
  desired: synapse.ServerBlobAuditingPolicyProperties,
  storageAccountAccessKey: string | undefined,
) => ({
  label: `synapse workspace auditing on ${workspace}`,
  get: getPolicy(subscriptionId, resourceGroup, workspace),
  matches: (policy: ObservedPolicy) => fieldsMatch(policy.properties, desired),
  put: synapse.WorkspaceManagedSqlServerBlobAuditingPoliciesCreateOrUpdate({
    subscriptionId,
    resourceGroupName: resourceGroup,
    workspaceName: workspace,
    blobAuditingPolicyName: POLICY_NAME,
    properties: { ...desired, storageAccountAccessKey },
  }),
});

export const WorkspaceAuditingSettingProvider = () =>
  Provider.succeed(WorkspaceAuditingSetting, {
    stables: ["settingId", "workspaceName", "resourceGroup"],

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
        `${resourceGroup}/${workspace}/audit`,
        news.storageAccountAccessKey,
      );
      // The key is write-only: re-send the policy when it changed.
      const keyChanged =
        news.storageAccountAccessKey !== undefined &&
        !sameSecret(fingerprint, output?.keyFingerprint);
      const sync = settingSync(
        subscriptionId,
        resourceGroup,
        workspace,
        {
          ...auditingProperties(news),
          isDevopsAuditEnabled: news.isDevopsAuditEnabled,
        },
        unwrapSecret(news.storageAccountAccessKey),
      );
      const observed = yield* sync.get;
      if (keyChanged && observed !== undefined && sync.matches(observed)) {
        yield* sync.put;
      }
      const fresh = yield* syncSetting(sync);
      return toAttrs(resourceGroup, workspace, fresh, fingerprint);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      // The policy is never removed; disable auditing.
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
