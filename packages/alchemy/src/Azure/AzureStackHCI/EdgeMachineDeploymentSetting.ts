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
import {
  HCI_NAMESPACE,
  isStackOwnedTags,
  sameId,
  sameValue,
} from "./Common.ts";
import { getHciEdgeMachine } from "./EdgeMachine.ts";

/** Single-machine deployment configuration (scale units). */
export type EdgeMachineDeploymentConfiguration =
  hci.EdgeMachineDeploymentConfiguration;

export interface EdgeMachineDeploymentSettingProps {
  /** Resource group of the edge machine. Changing it replaces the edge machine deployment. */
  resourceGroup: string;
  /** Name of the parent edge machine. Changing it replaces the edge machine deployment. */
  edgeMachine: string;
  /**
   * Name of the deployment setting. Changing it replaces the setting.
   * @default "default"
   */
  name?: string;
  /** Single-machine deployment configuration (scale units). */
  deploymentConfiguration: EdgeMachineDeploymentConfiguration;
}

export interface EdgeMachineDeploymentSetting extends Resource<
  "Azure.AzureStackHCI.EdgeMachineDeploymentSetting",
  EdgeMachineDeploymentSettingProps,
  {
    /** Name of the edge machine deployment. */
    deploymentSettingName: string;
    /** Name of the parent edge machine. */
    edgeMachineName: string;
    /** Resource group of the edge machine. */
    resourceGroup: string;
    /** ARM resource ID of the edge machine deployment. */
    deploymentSettingId: string;
    /** Provisioning state of the edge machine deployment. */
    provisioningState: string | undefined;
    /** Properties reported by the machine. */
    reportedProperties: hci.EceReportedProperties | undefined;
  },
  never,
  Providers
> {}

/**
 * Single-machine deployment of Azure Local onto a claimed edge machine.
 * A deployment runs for hours and needs real Azure Local hardware.
 *
 * It has no tags; Alchemy treats it as owned when its parent edge machine
 * carries this stack's ownership tags.
 *
 * @see https://learn.microsoft.com/azure/azure-local/overview
 *
 * ### Deploying a Machine
 * **Example:** Single-machine deployment
 * ```typescript
 * const machine = yield* Azure.AzureStackHCI.EdgeMachine("node-1", {
 *   resourceGroup: group.resourceGroupName,
 *   arcMachineResourceId: arcServerId,
 * });
 * yield* Azure.AzureStackHCI.EdgeMachineDeploymentSetting("deploy", {
 *   resourceGroup: group.resourceGroupName,
 *   edgeMachine: machine.edgeMachineName,
 *   deploymentConfiguration: { version: "10.0.0.0", scaleUnits: [{ ... }] },
 * });
 * ```
 *
 * @resource
 */
export const EdgeMachineDeploymentSetting =
  Resource<EdgeMachineDeploymentSetting>(
    "Azure.AzureStackHCI.EdgeMachineDeploymentSetting",
  );

const getEdgeMachineDeploymentSetting = (
  subscriptionId: string,
  resourceGroupName: string,
  edgeMachineName: string,
  deploymentSettingName: string,
) =>
  orUndefinedIfNotFound(
    hci.GetEdgeMachineDeploymentSettings({
      subscriptionId,
      resourceGroupName,
      edgeMachineName,
      deploymentSettingName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  edgeMachine: string,
  name: string,
  disk: hci.GetEdgeMachineDeploymentSettingsResponse,
): EdgeMachineDeploymentSetting["Attributes"] => ({
  deploymentSettingName: name,
  edgeMachineName: edgeMachine,
  resourceGroup,
  deploymentSettingId: disk.id ?? "",
  provisioningState: disk.properties?.provisioningState,
  reportedProperties: disk.properties?.reportedProperties,
});

export const EdgeMachineDeploymentSettingProvider = () =>
  Provider.succeed(EdgeMachineDeploymentSetting, {
    stables: [
      "deploymentSettingName",
      "edgeMachineName",
      "resourceGroup",
      "deploymentSettingId",
    ],

    // Removed with the parent edge machine.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameId(news.resourceGroup, output.resourceGroup) ||
        !sameId(news.edgeMachine, output.edgeMachineName) ||
        !sameId(news.name ?? "default", output.deploymentSettingName)
      ) {
        // The name is fixed per parent, so the old one must go first.
        return { action: "replace", deleteFirst: true } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const edgeMachine = output?.edgeMachineName ?? olds?.edgeMachine;
      const name = output?.deploymentSettingName ?? olds?.name ?? "default";
      if (
        resourceGroup === undefined ||
        edgeMachine === undefined ||
        name === undefined
      ) {
        return undefined;
      }
      const observed = yield* getEdgeMachineDeploymentSetting(
        subscriptionId,
        resourceGroup,
        edgeMachine,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, edgeMachine, name, observed);
      const parent = yield* getHciEdgeMachine(
        subscriptionId,
        resourceGroup,
        edgeMachine,
      );
      return (yield* isStackOwnedTags(parent?.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news, olds }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, HCI_NAMESPACE);
      const { resourceGroup, edgeMachine } = news;
      const name = news.name ?? "default";
      const get = getEdgeMachineDeploymentSetting(
        subscriptionId,
        resourceGroup,
        edgeMachine,
        name,
      );

      // Observe.
      const observed = yield* get;

      // Ensure + sync: the configuration is written through the PUT upsert.
      // Compare with the last deployed props (Azure normalizes the observed
      // configuration); on adoption, compare with the observed one.
      if (
        observed === undefined ||
        (olds !== undefined &&
          !sameValue(
            news.deploymentConfiguration,
            olds.deploymentConfiguration,
          )) ||
        (olds === undefined &&
          news.deploymentConfiguration !== undefined &&
          !sameValue(
            news.deploymentConfiguration,
            observed.properties?.deploymentConfiguration,
          ))
      ) {
        yield* hci.EdgeMachineDeploymentSettingsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          edgeMachineName: edgeMachine,
          deploymentSettingName: name,
          properties: { deploymentConfiguration: news.deploymentConfiguration },
        });
      }

      const fresh = yield* waitForProvisioned(
        `edge machine deployment ${edgeMachine}/${name}`,
        get,
        (value) => value.properties?.provisioningState,
        { interval: "30 seconds", times: 360 },
      );
      return toAttrs(resourceGroup, edgeMachine, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        hci.DeleteEdgeMachineDeploymentSettings({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          edgeMachineName: output.edgeMachineName,
          deploymentSettingName: output.deploymentSettingName,
        }),
      );
      yield* waitUntilGone(
        `edge machine deployment ${output.edgeMachineName}/${output.deploymentSettingName}`,
        getEdgeMachineDeploymentSetting(
          subscriptionId,
          output.resourceGroup,
          output.edgeMachineName,
          output.deploymentSettingName,
        ),
        { interval: "5 seconds", times: 60 },
      );
    }),
  });
