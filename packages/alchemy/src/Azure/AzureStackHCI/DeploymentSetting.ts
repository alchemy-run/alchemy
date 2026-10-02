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
import {
  HCI_NAMESPACE,
  isStackOwnedTags,
  sameId,
  sameValue,
} from "./Common.ts";

/**
 * Full Azure Local deployment configuration (scale units with cluster,
 * storage, networking, domain, observability, and secrets settings).
 */
export type HciDeploymentConfiguration = hci.DeploymentConfigurationInput;

export interface DeploymentSettingProps {
  /** Resource group of the cluster. Changing it replaces the setting. */
  resourceGroup: string;
  /** Name of the parent cluster record. Changing it replaces the setting. */
  cluster: string;
  /**
   * Name of the deployment setting. Changing it replaces the setting.
   * @default "default"
   */
  name?: string;
  /**
   * ARM IDs of the Arc-enabled servers (`Microsoft.HybridCompute/machines`)
   * that form the cluster. Changing them replaces the setting.
   */
  arcNodeResourceIds: string[];
  /**
   * `Validate` only checks the configuration against the nodes; `Deploy`
   * provisions the cluster. Switch from `Validate` to `Deploy` once
   * validation succeeds.
   */
  deploymentMode: "Validate" | "Deploy";
  /**
   * Operation to perform. Changing it replaces the setting.
   * @default "ClusterProvisioning"
   */
  operationType?: "ClusterProvisioning" | "ClusterUpgrade";
  /** Deployment configuration of the cluster. */
  deploymentConfiguration: HciDeploymentConfiguration;
}

export interface DeploymentSetting extends Resource<
  "Azure.AzureStackHCI.DeploymentSetting",
  DeploymentSettingProps,
  {
    /** Name of the deployment setting. */
    deploymentSettingName: string;
    /** Name of the parent cluster record. */
    clusterName: string;
    /** Resource group of the cluster. */
    resourceGroup: string;
    /** ARM resource ID of the deployment setting. */
    deploymentSettingId: string;
    /** Current deployment mode. */
    deploymentMode: string | undefined;
    /** Operation the setting performs. */
    operationType: string | undefined;
    /** ARM IDs of the cluster's Arc-enabled servers. */
    arcNodeResourceIds: string[];
    /** Provisioning state of the validation or deployment. */
    provisioningState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * Cloud deployment of an Azure Local cluster: validates and then deploys
 * the cluster onto Arc-registered physical nodes. A deployment runs for
 * hours and needs real Azure Local hardware.
 *
 * The setting has no tags; Alchemy treats it as owned when its parent
 * cluster carries this stack's ownership tags. Because Azure never returns
 * the configured secrets, the deployment configuration is compared with
 * the last deployed props rather than the observed resource.
 *
 * @see https://learn.microsoft.com/azure/azure-local/deploy/deployment-azure-resource-manager-template
 *
 * ### Validating and Deploying a Cluster
 * **Example:** Validate the configuration first
 * ```typescript
 * const deployment = yield* Azure.AzureStackHCI.DeploymentSetting("deploy", {
 *   resourceGroup: group.resourceGroupName,
 *   cluster: cluster.clusterName,
 *   arcNodeResourceIds: [node1Id, node2Id],
 *   deploymentMode: "Validate", // then "Deploy"
 *   deploymentConfiguration: {
 *     version: "10.0.0.0",
 *     scaleUnits: [{ deploymentData: { ... } }],
 *   },
 * });
 * ```
 *
 * @resource
 */
export const DeploymentSetting = Resource<DeploymentSetting>(
  "Azure.AzureStackHCI.DeploymentSetting",
);

const getDeploymentSetting = (
  subscriptionId: string,
  resourceGroupName: string,
  clusterName: string,
  deploymentSettingsName: string,
) =>
  orUndefinedIfNotFound(
    hci.GetDeploymentSettings({
      subscriptionId,
      resourceGroupName,
      clusterName,
      deploymentSettingsName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  cluster: string,
  name: string,
  setting: hci.GetDeploymentSettingsResponse,
): DeploymentSetting["Attributes"] => ({
  deploymentSettingName: name,
  clusterName: cluster,
  resourceGroup,
  deploymentSettingId: setting.id ?? "",
  deploymentMode: setting.properties?.deploymentMode,
  operationType: setting.properties?.operationType,
  arcNodeResourceIds: [...(setting.properties?.arcNodeResourceIds ?? [])],
  provisioningState: setting.properties?.provisioningState,
});

const sameIds = (a: readonly string[], b: readonly string[]) =>
  sameValue(
    a.map((id) => id.toLowerCase()).sort(),
    b.map((id) => id.toLowerCase()).sort(),
  );

export const DeploymentSettingProvider = () =>
  Provider.succeed(DeploymentSetting, {
    stables: [
      "deploymentSettingName",
      "clusterName",
      "resourceGroup",
      "deploymentSettingId",
    ],

    // Deployment settings are removed with their cluster.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameId(news.resourceGroup, output.resourceGroup) ||
        !sameId(news.cluster, output.clusterName) ||
        !sameId(news.name ?? "default", output.deploymentSettingName) ||
        !sameIds(news.arcNodeResourceIds, output.arcNodeResourceIds) ||
        (output.operationType !== undefined &&
          (news.operationType ?? "ClusterProvisioning") !==
            output.operationType)
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
      const name = output?.deploymentSettingName ?? olds?.name ?? "default";
      const observed = yield* getDeploymentSetting(
        subscriptionId,
        resourceGroup,
        cluster,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, cluster, name, observed);
      const parent = yield* getHciCluster(
        subscriptionId,
        resourceGroup,
        cluster,
      );
      return (yield* isStackOwnedTags(parent?.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news, olds }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, HCI_NAMESPACE);
      const { resourceGroup, cluster } = news;
      const name = news.name ?? "default";
      const get = getDeploymentSetting(
        subscriptionId,
        resourceGroup,
        cluster,
        name,
      );

      // Observe.
      const observed = yield* get;

      // Ensure + sync: the setting is written through a full PUT. Write it
      // when missing, when the mode drifted from the observed one, or when
      // the configuration changed since the last deploy.
      const configChanged =
        olds !== undefined &&
        !sameValue(news.deploymentConfiguration, olds.deploymentConfiguration);
      if (
        observed === undefined ||
        observed.properties?.deploymentMode !== news.deploymentMode ||
        configChanged
      ) {
        yield* hci.DeploymentSettingsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          clusterName: cluster,
          deploymentSettingsName: name,
          properties: {
            arcNodeResourceIds: news.arcNodeResourceIds,
            deploymentMode: news.deploymentMode,
            operationType: news.operationType ?? "ClusterProvisioning",
            deploymentConfiguration: news.deploymentConfiguration,
          },
        });
      }

      // Validation takes tens of minutes; a deployment takes hours.
      const fresh = yield* waitForProvisioned(
        `Azure Local deployment ${cluster}/${name}`,
        get,
        (setting) => setting.properties?.provisioningState,
        { interval: "30 seconds", times: 360 },
      );
      return toAttrs(resourceGroup, cluster, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        hci.DeleteDeploymentSettings({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          clusterName: output.clusterName,
          deploymentSettingsName: output.deploymentSettingName,
        }),
      );
      yield* waitUntilGone(
        `Azure Local deployment ${output.clusterName}/${output.deploymentSettingName}`,
        getDeploymentSetting(
          subscriptionId,
          output.resourceGroup,
          output.clusterName,
          output.deploymentSettingName,
        ),
        { interval: "10 seconds", times: 60 },
      );
    }),
  });
