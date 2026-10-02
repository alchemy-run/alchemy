import * as hci from "@distilled.cloud/azure/azurestackhci";
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
import { getHciCluster } from "./Cluster.ts";
import { HCI_NAMESPACE, isStackOwnedTags, sameId } from "./Common.ts";

/** How a security baseline is enforced on the cluster's nodes. */
export type ComplianceAssignment = "Audit" | "ApplyAndAutoCorrect";

export interface SecuritySettingProps {
  /** Resource group of the cluster. Changing it replaces the setting. */
  resourceGroup: string;
  /** Name of the parent cluster record. Changing it replaces the setting. */
  cluster: string;
  /**
   * Secured-core compliance assignment.
   * @default "Audit"
   */
  securedCoreComplianceAssignment?: ComplianceAssignment;
  /**
   * Windows Defender Application Control (WDAC) compliance assignment.
   * @default "Audit"
   */
  wdacComplianceAssignment?: ComplianceAssignment;
  /**
   * SMB encryption for intra-cluster traffic compliance assignment.
   * @default "Audit"
   */
  smbEncryptionForIntraClusterTrafficComplianceAssignment?: ComplianceAssignment;
}

export interface SecuritySetting extends Resource<
  "Azure.AzureStackHCI.SecuritySetting",
  SecuritySettingProps,
  {
    /** Name of the parent cluster record. */
    clusterName: string;
    /** Resource group of the cluster. */
    resourceGroup: string;
    /** ARM resource ID of the security setting (always named `default`). */
    securitySettingId: string;
    /** Secured-core compliance assignment. */
    securedCoreComplianceAssignment: string;
    /** WDAC compliance assignment. */
    wdacComplianceAssignment: string;
    /** SMB encryption for intra-cluster traffic compliance assignment. */
    smbEncryptionForIntraClusterTrafficComplianceAssignment: string;
    /** Secured-core compliance reported by the cluster (`Pending` until nodes report). */
    securedCoreCompliance: string | undefined;
    /** WDAC compliance reported by the cluster. */
    wdacCompliance: string | undefined;
  },
  never,
  Providers
> {}

/**
 * The security baseline of an Azure Local cluster record (the singleton
 * `securitySettings/default`): secured-core, WDAC, and SMB encryption
 * compliance assignments.
 *
 * The setting has no tags; Alchemy treats it as owned when its parent
 * cluster carries this stack's ownership tags.
 *
 * @see https://learn.microsoft.com/azure/azure-local/manage/manage-secure-baseline
 *
 * ### Configuring the Security Baseline
 * **Example:** Enforce WDAC and SMB encryption
 * ```typescript
 * const cluster = yield* Azure.AzureStackHCI.Cluster("site-a", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * yield* Azure.AzureStackHCI.SecuritySetting("security", {
 *   resourceGroup: group.resourceGroupName,
 *   cluster: cluster.clusterName,
 *   wdacComplianceAssignment: "ApplyAndAutoCorrect",
 *   smbEncryptionForIntraClusterTrafficComplianceAssignment:
 *     "ApplyAndAutoCorrect",
 * });
 * ```
 *
 * @resource
 */
export const SecuritySetting = Resource<SecuritySetting>(
  "Azure.AzureStackHCI.SecuritySetting",
);

const SETTING_NAME = "default";

const getSecuritySetting = (
  subscriptionId: string,
  resourceGroupName: string,
  clusterName: string,
) =>
  orUndefinedIfNotFound(
    hci.GetSecuritySettings({
      subscriptionId,
      resourceGroupName,
      clusterName,
      securitySettingsName: SETTING_NAME,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  cluster: string,
  setting: hci.GetSecuritySettingsResponse,
): SecuritySetting["Attributes"] => ({
  clusterName: cluster,
  resourceGroup,
  securitySettingId: setting.id ?? "",
  securedCoreComplianceAssignment:
    setting.properties?.securedCoreComplianceAssignment ?? "Audit",
  wdacComplianceAssignment:
    setting.properties?.wdacComplianceAssignment ?? "Audit",
  smbEncryptionForIntraClusterTrafficComplianceAssignment:
    setting.properties
      ?.smbEncryptionForIntraClusterTrafficComplianceAssignment ?? "Audit",
  securedCoreCompliance:
    setting.properties?.securityComplianceStatus?.securedCoreCompliance,
  wdacCompliance: setting.properties?.securityComplianceStatus?.wdacCompliance,
});

export const SecuritySettingProvider = () =>
  Provider.succeed(SecuritySetting, {
    stables: ["clusterName", "resourceGroup", "securitySettingId"],

    // Security settings are removed with their cluster.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameId(news.resourceGroup, output.resourceGroup) ||
        !sameId(news.cluster, output.clusterName)
      ) {
        // The name is fixed per parent, so the old one must go first.
        return { action: "replace", deleteFirst: true } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const cluster = output?.clusterName ?? olds?.cluster;
      if (resourceGroup === undefined || cluster === undefined) {
        return undefined;
      }
      const observed = yield* getSecuritySetting(
        subscriptionId,
        resourceGroup,
        cluster,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, cluster, observed);
      const parent = yield* getHciCluster(
        subscriptionId,
        resourceGroup,
        cluster,
      );
      return (yield* isStackOwnedTags(parent?.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, HCI_NAMESPACE);
      const { resourceGroup, cluster } = news;
      const desired = {
        securedCoreComplianceAssignment:
          news.securedCoreComplianceAssignment ?? "Audit",
        wdacComplianceAssignment: news.wdacComplianceAssignment ?? "Audit",
        smbEncryptionForIntraClusterTrafficComplianceAssignment:
          news.smbEncryptionForIntraClusterTrafficComplianceAssignment ??
          "Audit",
      };
      const get = getSecuritySetting(subscriptionId, resourceGroup, cluster);

      // Observe.
      let observed = yield* get;

      // Ensure + sync: the singleton is only written through a full PUT,
      // so write it when it is missing or any assignment drifted.
      const drifted =
        observed === undefined ||
        (Object.keys(desired) as (keyof typeof desired)[]).some(
          (key) => (observed?.properties?.[key] ?? "Audit") !== desired[key],
        );
      if (drifted) {
        yield* hci.SecuritySettingsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          clusterName: cluster,
          securitySettingsName: SETTING_NAME,
          properties: desired,
        });
      }
      observed = yield* waitForProvisioned(
        `security setting of ${cluster}`,
        get,
        (setting) => setting.properties?.provisioningState,
      );

      return toAttrs(resourceGroup, cluster, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        hci.DeleteSecuritySettings({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          clusterName: output.clusterName,
          securitySettingsName: SETTING_NAME,
        }),
      );
      yield* waitUntilGone(
        `security setting of ${output.clusterName}`,
        getSecuritySetting(
          subscriptionId,
          output.resourceGroup,
          output.clusterName,
        ),
        { interval: "5 seconds", times: 60 },
      );
    }),
  });
