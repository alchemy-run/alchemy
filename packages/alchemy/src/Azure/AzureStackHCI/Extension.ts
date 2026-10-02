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

export interface ExtensionProps {
  /** Resource group of the cluster. Changing it replaces the extension. */
  resourceGroup: string;
  /** Name of the parent cluster record. Changing it replaces the extension. */
  cluster: string;
  /** Name of the parent Arc setting. Changing it replaces the extension. */
  arcSetting: string;
  /**
   * Name of the extension. Changing it replaces the extension.
   * @default the extension `type`
   */
  name?: string;
  /**
   * Publisher of the extension handler, e.g. `Microsoft.Azure.Monitor`.
   * Changing it replaces the extension.
   */
  publisher: string;
  /**
   * Type of the extension, e.g. `AzureMonitorWindowsAgent`. Changing it
   * replaces the extension.
   */
  type: string;
  /** Version of the extension handler, e.g. `1.10`. */
  typeHandlerVersion?: string;
  /**
   * Whether the latest minor version is used at deployment time. Changing
   * it replaces the extension.
   */
  autoUpgradeMinorVersion?: boolean;
  /** Whether the platform upgrades the extension automatically when a new version is published. */
  enableAutomaticUpgrade?: boolean;
  /** Public JSON settings of the extension. */
  settings?: Record<string, unknown>;
  /**
   * Protected JSON settings (encrypted at rest, never returned by Azure).
   * Re-sent only when they differ from the last deployed value.
   */
  protectedSettings?: Record<string, unknown>;
}

export interface Extension extends Resource<
  "Azure.AzureStackHCI.Extension",
  ExtensionProps,
  {
    /** Name of the extension. */
    extensionName: string;
    /** Name of the parent Arc setting. */
    arcSettingName: string;
    /** Name of the parent cluster record. */
    clusterName: string;
    /** Resource group of the cluster. */
    resourceGroup: string;
    /** ARM resource ID of the extension. */
    extensionId: string;
    /** Publisher of the extension handler. */
    publisher: string | undefined;
    /** Type of the extension. */
    type: string | undefined;
    /** Version of the extension handler. */
    typeHandlerVersion: string | undefined;
    /** Aggregate installation state across the cluster's nodes. */
    aggregateState: string | undefined;
    /** Who manages the extension (`User` or `Azure`). */
    managedBy: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An Arc extension installed on every node of an Azure Local cluster
 * (e.g. Azure Monitor Agent), managed through the cluster's Arc setting.
 * Installation needs a registered cluster with Arc-connected nodes.
 *
 * The extension has no tags; Alchemy treats it as owned when its parent
 * cluster carries this stack's ownership tags.
 *
 * @see https://learn.microsoft.com/azure/azure-local/manage/arc-extension-management
 *
 * ### Installing an Extension
 * **Example:** Azure Monitor Agent on every node
 * ```typescript
 * const arc = yield* Azure.AzureStackHCI.ArcSetting("arc", {
 *   resourceGroup: group.resourceGroupName,
 *   cluster: cluster.clusterName,
 *   arcInstanceResourceGroup: group.resourceGroupName,
 * });
 * yield* Azure.AzureStackHCI.Extension("monitor", {
 *   resourceGroup: group.resourceGroupName,
 *   cluster: cluster.clusterName,
 *   arcSetting: arc.arcSettingName,
 *   publisher: "Microsoft.Azure.Monitor",
 *   type: "AzureMonitorWindowsAgent",
 *   autoUpgradeMinorVersion: true,
 *   enableAutomaticUpgrade: true,
 * });
 * ```
 *
 * @resource
 */
export const Extension = Resource<Extension>("Azure.AzureStackHCI.Extension");

const getExtension = (
  subscriptionId: string,
  resourceGroupName: string,
  clusterName: string,
  arcSettingName: string,
  extensionName: string,
) =>
  orUndefinedIfNotFound(
    hci.GetExtension({
      subscriptionId,
      resourceGroupName,
      clusterName,
      arcSettingName,
      extensionName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  cluster: string,
  arcSetting: string,
  name: string,
  extension: hci.GetExtensionResponse,
): Extension["Attributes"] => {
  const parameters = extension.properties?.extensionParameters;
  return {
    extensionName: name,
    arcSettingName: arcSetting,
    clusterName: cluster,
    resourceGroup,
    extensionId: extension.id ?? "",
    publisher: parameters?.publisher,
    type: parameters?.type,
    typeHandlerVersion: parameters?.typeHandlerVersion,
    aggregateState: extension.properties?.aggregateState,
    managedBy: extension.properties?.managedBy,
  };
};

export const ExtensionProvider = () =>
  Provider.succeed(Extension, {
    stables: [
      "extensionName",
      "arcSettingName",
      "clusterName",
      "resourceGroup",
      "extensionId",
    ],

    // Extensions are removed with their Arc setting and cluster.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameId(news.resourceGroup, output.resourceGroup) ||
        !sameId(news.cluster, output.clusterName) ||
        !sameId(news.arcSetting, output.arcSettingName) ||
        !sameId(news.name ?? news.type, output.extensionName) ||
        (output.publisher !== undefined &&
          !sameId(news.publisher, output.publisher)) ||
        (output.type !== undefined && !sameId(news.type, output.type)) ||
        (olds !== undefined &&
          news.autoUpgradeMinorVersion !== olds.autoUpgradeMinorVersion)
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
      const arcSetting = output?.arcSettingName ?? olds?.arcSetting;
      const name = output?.extensionName ?? olds?.name ?? olds?.type;
      if (
        resourceGroup === undefined ||
        cluster === undefined ||
        arcSetting === undefined ||
        name === undefined
      ) {
        return undefined;
      }
      const observed = yield* getExtension(
        subscriptionId,
        resourceGroup,
        cluster,
        arcSetting,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, cluster, arcSetting, name, observed);
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
      const { resourceGroup, cluster, arcSetting } = news;
      const name = news.name ?? news.type;
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        clusterName: cluster,
        arcSettingName: arcSetting,
        extensionName: name,
      };
      const get = getExtension(
        subscriptionId,
        resourceGroup,
        cluster,
        arcSetting,
        name,
      );
      // Installing on every node can take several minutes.
      const settle = waitForProvisioned(
        `Azure Local extension ${name}`,
        get,
        (extension) => extension.properties?.provisioningState,
        { interval: "10 seconds", times: 60 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* hci.CreateExtension({
          ...where,
          properties: {
            extensionParameters: {
              publisher: news.publisher,
              type: news.type,
              typeHandlerVersion: news.typeHandlerVersion,
              autoUpgradeMinorVersion: news.autoUpgradeMinorVersion,
              enableAutomaticUpgrade: news.enableAutomaticUpgrade,
              settings: news.settings,
              protectedSettings: news.protectedSettings,
            },
          },
        });
        observed = yield* settle;
      }

      // Sync the patchable parameters against the observed extension.
      // Protected settings are never returned, so they are compared with
      // the last deployed props.
      const current = observed.properties?.extensionParameters;
      const patch: hci.ExtensionPatchParameters = {};
      if (
        news.typeHandlerVersion !== undefined &&
        news.typeHandlerVersion !== current?.typeHandlerVersion
      ) {
        patch.typeHandlerVersion = news.typeHandlerVersion;
      }
      if (
        news.enableAutomaticUpgrade !== undefined &&
        news.enableAutomaticUpgrade !== current?.enableAutomaticUpgrade
      ) {
        patch.enableAutomaticUpgrade = news.enableAutomaticUpgrade;
      }
      if (
        news.settings !== undefined &&
        !sameValue(news.settings, current?.settings)
      ) {
        patch.settings = news.settings;
      }
      if (
        olds !== undefined &&
        news.protectedSettings !== undefined &&
        !sameValue(news.protectedSettings, olds.protectedSettings)
      ) {
        patch.protectedSettings = news.protectedSettings;
      }
      if (Object.keys(patch).length > 0) {
        yield* hci.UpdateExtension({
          ...where,
          properties: { extensionParameters: patch },
        });
        observed = yield* settle;
      }

      return toAttrs(resourceGroup, cluster, arcSetting, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const where = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        clusterName: output.clusterName,
        arcSettingName: output.arcSettingName,
        extensionName: output.extensionName,
      };
      yield* ignoreNotFound(hci.DeleteExtension(where));
      yield* waitUntilGone(
        `Azure Local extension ${output.extensionName}`,
        getExtension(
          subscriptionId,
          output.resourceGroup,
          output.clusterName,
          output.arcSettingName,
          output.extensionName,
        ),
        { interval: "10 seconds", times: 60 },
      );
    }),
  });
