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
import { HCI_NAMESPACE, isStackOwnedTags, sameId } from "./Common.ts";
import { getHciEdgeMachine } from "./EdgeMachine.ts";

export interface EdgeMachineSecuritySettingProps {
  /** Resource group of the edge machine. Changing it replaces the edge machine security setting. */
  resourceGroup: string;
  /** Name of the parent edge machine. Changing it replaces the edge machine security setting. */
  edgeMachine: string;
  /**
   * Name of the security setting. Changing it replaces the setting.
   * @default "default"
   */
  name?: string;
}

export interface EdgeMachineSecuritySetting extends Resource<
  "Azure.AzureStackHCI.EdgeMachineSecuritySetting",
  EdgeMachineSecuritySettingProps,
  {
    /** Name of the edge machine security setting. */
    securitySettingName: string;
    /** Name of the parent edge machine. */
    edgeMachineName: string;
    /** Resource group of the edge machine. */
    resourceGroup: string;
    /** ARM resource ID of the edge machine security setting. */
    securitySettingId: string;
    /** Provisioning state of the edge machine security setting. */
    provisioningState: string | undefined;
    /** Compliance status reported by the machine. */
    securityComplianceStatus:
      | hci.EdgeMachineSecurityComplianceStatus
      | undefined;
  },
  never,
  Providers
> {}

/**
 * The security baseline record of an Azure Local edge machine; Azure
 * reports FIPS, secure boot, encryption-at-rest, and SELinux compliance on
 * it. It has no configurable properties. Needs a claimed, connected
 * physical machine.
 *
 * It has no tags; Alchemy treats it as owned when its parent edge machine
 * carries this stack's ownership tags.
 *
 * @see https://learn.microsoft.com/azure/azure-local/overview
 *
 * ### Tracking Security Compliance
 * **Example:** Security setting of an edge machine
 * ```typescript
 * const machine = yield* Azure.AzureStackHCI.EdgeMachine("node-1", {
 *   resourceGroup: group.resourceGroupName,
 *   arcMachineResourceId: arcServerId,
 * });
 * yield* Azure.AzureStackHCI.EdgeMachineSecuritySetting("security", {
 *   resourceGroup: group.resourceGroupName,
 *   edgeMachine: machine.edgeMachineName,
 * });
 * ```
 *
 * @resource
 */
export const EdgeMachineSecuritySetting = Resource<EdgeMachineSecuritySetting>(
  "Azure.AzureStackHCI.EdgeMachineSecuritySetting",
);

const getEdgeMachineSecuritySetting = (
  subscriptionId: string,
  resourceGroupName: string,
  edgeMachineName: string,
  securitySettingsName: string,
) =>
  orUndefinedIfNotFound(
    hci.GetEdgeMachineSecuritySettingsOperation({
      subscriptionId,
      resourceGroupName,
      edgeMachineName,
      securitySettingsName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  edgeMachine: string,
  name: string,
  disk: hci.GetEdgeMachineSecuritySettingsOperationResponse,
): EdgeMachineSecuritySetting["Attributes"] => ({
  securitySettingName: name,
  edgeMachineName: edgeMachine,
  resourceGroup,
  securitySettingId: disk.id ?? "",
  provisioningState: disk.properties?.provisioningState,
  securityComplianceStatus: disk.properties?.securityComplianceStatus,
});

export const EdgeMachineSecuritySettingProvider = () =>
  Provider.succeed(EdgeMachineSecuritySetting, {
    stables: [
      "securitySettingName",
      "edgeMachineName",
      "resourceGroup",
      "securitySettingId",
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
        !sameId(news.name ?? "default", output.securitySettingName)
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
      const name = output?.securitySettingName ?? olds?.name ?? "default";
      if (
        resourceGroup === undefined ||
        edgeMachine === undefined ||
        name === undefined
      ) {
        return undefined;
      }
      const observed = yield* getEdgeMachineSecuritySetting(
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

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, HCI_NAMESPACE);
      const { resourceGroup, edgeMachine } = news;
      const name = news.name ?? "default";
      const get = getEdgeMachineSecuritySetting(
        subscriptionId,
        resourceGroup,
        edgeMachine,
        name,
      );

      // Observe.
      const observed = yield* get;

      // Ensure: the setting has no configurable properties.
      if (observed === undefined) {
        yield* hci.EdgeMachineSecuritySettingsOperationsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          edgeMachineName: edgeMachine,
          securitySettingsName: name,
          properties: {},
        });
      }

      const fresh = yield* waitForProvisioned(
        `edge machine security setting ${edgeMachine}/${name}`,
        get,
        (value) => value.properties?.provisioningState,
        { interval: "5 seconds", times: 60 },
      );
      return toAttrs(resourceGroup, edgeMachine, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        hci.DeleteEdgeMachineSecuritySettingsOperation({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          edgeMachineName: output.edgeMachineName,
          securitySettingsName: output.securitySettingName,
        }),
      );
      yield* waitUntilGone(
        `edge machine security setting ${output.edgeMachineName}/${output.securitySettingName}`,
        getEdgeMachineSecuritySetting(
          subscriptionId,
          output.resourceGroup,
          output.edgeMachineName,
          output.securitySettingName,
        ),
        { interval: "5 seconds", times: 60 },
      );
    }),
  });
