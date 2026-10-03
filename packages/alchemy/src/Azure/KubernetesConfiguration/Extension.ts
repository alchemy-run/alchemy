import * as kc from "@distilled.cloud/azure/kubernetesconfiguration";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
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
import { createChildName, sameName } from "../ContainerService/Common.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  type ClusterRef,
  isHostOwned,
  parseClusterId,
  revealMap,
  sameSecrets,
} from "./Common.ts";

/** Where the extension's Helm release is installed. Set one of the two. */
export interface ExtensionScope {
  /** Install cluster-wide. */
  cluster?: {
    /**
     * Namespace of the Helm release; created if missing.
     * @default the extension type's default namespace
     */
    releaseNamespace?: string;
  };
  /** Install into a single namespace. */
  namespace?: {
    /** Namespace to install into; created if missing. */
    targetNamespace?: string;
  };
}

/** Marketplace plan of a third-party extension. */
export interface ExtensionPlan {
  /** Plan name. */
  name: string;
  /** Publisher of the offer, e.g. `NewRelic`. */
  publisher: string;
  /** Offer ID of the product. */
  product: string;
  /** Publisher-provided promotion code. */
  promotionCode?: string;
  /** Version of the product. */
  version?: string;
}

export interface ExtensionProps {
  /**
   * ARM resource ID of the cluster that hosts the extension: an AKS managed
   * cluster (`Microsoft.ContainerService/managedClusters`), an Arc connected
   * cluster (`Microsoft.Kubernetes/connectedClusters`), or a hybrid
   * provisioned cluster. Changing it replaces the extension.
   */
  clusterId: string;
  /**
   * Extension name: lowercase letters, digits, `-` and `.`. If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the extension.
   */
  name?: string;
  /**
   * Registered extension type, e.g. `microsoft.flux`,
   * `microsoft.dapr`, `microsoft.azuremonitor.containers`. Changing it
   * replaces the extension.
   */
  extensionType: string;
  /**
   * Install scope (cluster-wide or a single namespace). Changing it
   * replaces the extension.
   * @default cluster scope with the type's default release namespace
   */
  scope?: ExtensionScope;
  /**
   * Whether the extension follows minor version upgrades of its release
   * train automatically. Must be `false` to pin `version`.
   * @default true
   */
  autoUpgradeMinorVersion?: boolean;
  /**
   * Release train used for auto-upgrade, e.g. `Stable` or `Preview`. Only
   * applies when `autoUpgradeMinorVersion` is `true`.
   * @default "Stable"
   */
  releaseTrain?: string;
  /**
   * Version to pin. Requires `autoUpgradeMinorVersion: false`.
   */
  version?: string;
  /**
   * Helm configuration settings passed to the extension, as name-value
   * pairs. Keys are added or changed in place; Azure merges the map, so
   * removing a key does not unset it.
   */
  configurationSettings?: Record<string, string>;
  /**
   * Sensitive configuration settings. Azure never returns them, so they are
   * re-sent whenever their values change from the last deploy.
   */
  configurationProtectedSettings?: Record<
    string,
    string | Redacted.Redacted<string>
  >;
  /**
   * Give the extension resource a system-assigned identity (used by Arc
   * extensions). Changing it replaces the extension.
   * @default false
   */
  systemAssignedIdentity?: boolean;
  /**
   * Marketplace plan for third-party extensions. Changing it replaces the
   * extension.
   */
  plan?: ExtensionPlan;
}

export interface Extension extends Resource<
  "Azure.KubernetesConfiguration.Extension",
  ExtensionProps,
  {
    /** Name of the extension. */
    extensionName: string;
    /** ARM resource ID of the extension. */
    extensionId: string;
    /** ARM resource ID of the hosting cluster. */
    clusterId: string;
    /** Resource group of the hosting cluster. */
    resourceGroup: string;
    /** Name of the hosting cluster. */
    clusterName: string;
    /** Extension type, e.g. `microsoft.flux`. */
    extensionType: string;
    /** Provisioning state reported by Azure. */
    provisioningState: string | undefined;
    /** Installed version of the extension. */
    currentVersion: string | undefined;
    /** Whether the extension follows minor version upgrades. */
    autoUpgradeMinorVersion: boolean | undefined;
    /** Release train of the extension. */
    releaseTrain: string | undefined;
    /** Observed (non-secret) configuration settings. */
    configurationSettings: Record<string, string>;
    /** Principal ID of the identity AKS assigned to the extension. */
    aksAssignedIdentityPrincipalId: string | undefined;
    /** Principal ID of the extension's system-assigned identity. */
    identityPrincipalId: string | undefined;
    /** Whether this is a system extension. */
    isSystemExtension: boolean | undefined;
  },
  never,
  Providers
> {}

/**
 * A cluster extension: an Azure-managed Helm release (Flux, Dapr, Azure
 * Monitor, Azure ML, Key Vault secrets provider, ...) installed into an AKS
 * or Arc-enabled Kubernetes cluster.
 *
 * Extensions cannot be tagged; ownership follows the hosting AKS cluster's
 * Alchemy tags.
 *
 * @see https://learn.microsoft.com/azure/aks/cluster-extensions
 *
 * ### Installing an Extension
 * **Example:** Install Flux (GitOps) on an AKS cluster
 * ```typescript
 * const flux = yield* Azure.KubernetesConfiguration.Extension("Flux", {
 *   clusterId: cluster.clusterId,
 *   extensionType: "microsoft.flux",
 * });
 * ```
 *
 * **Example:** Install into a specific namespace
 * ```typescript
 * yield* Azure.KubernetesConfiguration.Extension("Dapr", {
 *   clusterId: cluster.clusterId,
 *   extensionType: "microsoft.dapr",
 *   scope: { cluster: { releaseNamespace: "dapr-system" } },
 * });
 * ```
 *
 * ### Configuring an Extension
 * **Example:** Pass Helm settings
 * ```typescript
 * yield* Azure.KubernetesConfiguration.Extension("Flux", {
 *   clusterId: cluster.clusterId,
 *   extensionType: "microsoft.flux",
 *   configurationSettings: {
 *     "helm-controller.enabled": "false",
 *   },
 * });
 * ```
 *
 * **Example:** Pin a version
 * ```typescript
 * yield* Azure.KubernetesConfiguration.Extension("Flux", {
 *   clusterId: cluster.clusterId,
 *   extensionType: "microsoft.flux",
 *   autoUpgradeMinorVersion: false,
 *   version: "1.13.1",
 * });
 * ```
 *
 * @resource
 */
export const Extension = Resource<Extension>(
  "Azure.KubernetesConfiguration.Extension",
);

type ObservedExtension = kc.GetExtensionResponse;

const createExtensionName = (id: string) => createChildName(id, 40);

const getExtension = (
  subscriptionId: string,
  ref: ClusterRef,
  extensionName: string,
) =>
  orUndefinedIfNotFound(
    kc.GetExtension({ subscriptionId, ...ref, extensionName }),
  );

const definedSettings = (
  settings: Record<string, string | undefined> | null | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(settings ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

const toAttrs = (
  clusterId: string,
  ref: ClusterRef,
  name: string,
  extension: ObservedExtension,
): Extension["Attributes"] => {
  const props = extension.properties;
  return {
    extensionName: name,
    extensionId: extension.id ?? "",
    clusterId,
    resourceGroup: ref.resourceGroupName,
    clusterName: ref.clusterName,
    extensionType: props?.extensionType ?? "",
    provisioningState: props?.provisioningState,
    currentVersion: props?.currentVersion ?? undefined,
    autoUpgradeMinorVersion: props?.autoUpgradeMinorVersion,
    releaseTrain: props?.releaseTrain,
    configurationSettings: definedSettings(props?.configurationSettings),
    aksAssignedIdentityPrincipalId:
      props?.aksAssignedIdentity?.principalId ?? undefined,
    identityPrincipalId: extension.identity?.principalId,
    isSystemExtension: props?.isSystemExtension,
  };
};

const stateOf = (extension: ObservedExtension) =>
  extension.properties?.provisioningState;

/** PATCH body with only the mutable fields that drifted from `observed`. */
const updateDelta = (
  news: ExtensionProps,
  olds: ExtensionProps | undefined,
  observed: ObservedExtension,
): kc.UpdateExtensionRequestProperties | undefined => {
  const props = observed.properties;
  const delta: kc.UpdateExtensionRequestProperties = {};
  const autoUpgrade = news.autoUpgradeMinorVersion ?? true;
  if (props?.autoUpgradeMinorVersion !== autoUpgrade) {
    delta.autoUpgradeMinorVersion = autoUpgrade;
  }
  if (
    autoUpgrade &&
    news.releaseTrain !== undefined &&
    !sameName(news.releaseTrain, props?.releaseTrain)
  ) {
    delta.releaseTrain = news.releaseTrain;
  }
  if (
    !autoUpgrade &&
    news.version !== undefined &&
    news.version !== (props?.version ?? props?.currentVersion)
  ) {
    delta.version = news.version;
  }
  const observedSettings = definedSettings(props?.configurationSettings);
  const desiredSettings = news.configurationSettings ?? {};
  if (
    Object.entries(desiredSettings).some(
      ([key, value]) => observedSettings[key] !== value,
    )
  ) {
    delta.configurationSettings = desiredSettings;
  }
  // Protected settings are never returned: re-send when they changed since
  // the last deploy, or when there is no previous deploy to compare with.
  if (
    news.configurationProtectedSettings !== undefined &&
    (olds === undefined ||
      !sameSecrets(
        news.configurationProtectedSettings,
        olds.configurationProtectedSettings,
      ))
  ) {
    delta.configurationProtectedSettings = revealMap(
      news.configurationProtectedSettings,
    );
  }
  return Object.keys(delta).length === 0 ? undefined : delta;
};

const samePlan = (
  a: ExtensionPlan | undefined,
  b: ExtensionPlan | undefined,
) =>
  a === undefined || b === undefined
    ? a === b
    : sameName(a.name, b.name) &&
      sameName(a.publisher, b.publisher) &&
      sameName(a.product, b.product) &&
      a.version === b.version;

export const ExtensionProvider = () =>
  Provider.succeed(Extension, {
    stables: [
      "extensionName",
      "extensionId",
      "clusterId",
      "resourceGroup",
      "clusterName",
      "extensionType",
    ],

    // Extensions live inside a cluster; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.clusterId, output.clusterId) ||
        (news.name !== undefined && news.name !== output.extensionName) ||
        !sameName(news.extensionType, output.extensionType) ||
        (olds !== undefined &&
          (JSON.stringify(news.scope ?? null) !==
            JSON.stringify(olds.scope ?? null) ||
            (news.systemAssignedIdentity ?? false) !==
              (olds.systemAssignedIdentity ?? false) ||
            !samePlan(news.plan, olds.plan)))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const clusterId = output?.clusterId ?? olds?.clusterId;
      if (clusterId === undefined) return undefined;
      const ref = yield* parseClusterId(clusterId);
      const name =
        output?.extensionName ?? olds?.name ?? (yield* createExtensionName(id));
      const observed = yield* getExtension(subscriptionId, ref, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(clusterId, ref, name, observed);
      return (yield* isHostOwned(subscriptionId, ref)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(
        subscriptionId,
        "Microsoft.KubernetesConfiguration",
      );
      const ref = yield* parseClusterId(news.clusterId);
      const name =
        news.name ?? output?.extensionName ?? (yield* createExtensionName(id));
      const get = getExtension(subscriptionId, ref, name);
      // Helm installs take a few minutes.
      const waitReady = waitForProvisioned(
        `cluster extension ${ref.clusterName}/${name}`,
        get,
        stateOf,
        { interval: "10 seconds", times: 60 },
      );

      // Observe; (re)create when missing or a previous install failed.
      let observed = yield* get;
      // Baseline for protected settings, which Azure never returns.
      let baseline = olds;
      if (
        observed === undefined ||
        observed.properties?.provisioningState === "Failed"
      ) {
        const autoUpgrade = news.autoUpgradeMinorVersion ?? true;
        yield* kc.CreateExtension({
          subscriptionId,
          ...ref,
          extensionName: name,
          properties: {
            extensionType: news.extensionType,
            autoUpgradeMinorVersion: autoUpgrade,
            releaseTrain: autoUpgrade ? news.releaseTrain : undefined,
            version: autoUpgrade ? undefined : news.version,
            scope: news.scope,
            configurationSettings: news.configurationSettings,
            configurationProtectedSettings: revealMap(
              news.configurationProtectedSettings,
            ),
          },
          identity: news.systemAssignedIdentity
            ? { type: "SystemAssigned" }
            : undefined,
          plan: news.plan,
        });
        observed = yield* waitReady;
        // Protected settings were part of the PUT.
        baseline = news;
      } else {
        observed = yield* waitReady;
      }

      // Sync mutable settings against the observed extension.
      const delta = updateDelta(news, baseline, observed);
      if (delta !== undefined) {
        yield* kc.UpdateExtension({
          subscriptionId,
          ...ref,
          extensionName: name,
          properties: delta,
        });
        observed = yield* waitReady;
      }

      return toAttrs(news.clusterId, ref, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const ref = yield* parseClusterId(output.clusterId);
      yield* ignoreNotFound(
        kc.DeleteExtension({
          subscriptionId,
          ...ref,
          extensionName: output.extensionName,
        }),
      );
      // Helm uninstall runs in the cluster before the resource disappears.
      yield* waitUntilGone(
        `cluster extension ${output.clusterName}/${output.extensionName}`,
        getExtension(subscriptionId, ref, output.extensionName),
        { interval: "10 seconds", times: 60 },
      );
    }),
  });
