import * as compute from "@distilled.cloud/azure/compute";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  stackAndStage,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  canonical,
  createComputeName,
  protectedKey,
  sameId,
  waitComputeGone,
  waitComputeProvisioned,
  whileComputeBusy,
} from "./common.ts";

export interface VirtualMachineScaleSetExtensionProps {
  /**
   * Resource group of the scale set. Changing it replaces the extension.
   */
  resourceGroup: string;
  /**
   * Name of the scale set. Changing it replaces the extension.
   */
  virtualMachineScaleSet: string;
  /**
   * Name of the extension. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the extension.
   */
  name?: string;
  /**
   * Extension publisher, e.g. `Microsoft.Azure.Extensions`. Changing it
   * replaces the extension.
   */
  publisher: string;
  /**
   * Extension type, e.g. `CustomScript`. Changing it replaces the
   * extension.
   */
  type: string;
  /**
   * Extension handler version, e.g. `2.1`.
   */
  typeHandlerVersion: string;
  /**
   * Upgrade to newer minor versions of the handler at deployment time.
   * @default true
   */
  autoUpgradeMinorVersion?: boolean;
  /**
   * Let the platform upgrade the extension automatically when a newer
   * version is published.
   */
  enableAutomaticUpgrade?: boolean;
  /**
   * Public, extension-specific settings (JSON).
   */
  settings?: Record<string, unknown>;
  /**
   * Secret, extension-specific settings (JSON). Azure never returns them,
   * so changes are detected against the previous deployment.
   */
  protectedSettings?: Redacted.Redacted<Record<string, unknown>>;
  /**
   * Change this value to force the extension to re-run even when its
   * settings did not change.
   */
  forceUpdateTag?: string;
  /**
   * Names of extensions that must be provisioned before this one.
   */
  provisionAfterExtensions?: string[];
  /**
   * Do not fail instance provisioning when the extension fails.
   * @default false
   */
  suppressFailures?: boolean;
}

export interface VirtualMachineScaleSetExtension extends Resource<
  "Azure.Compute.VirtualMachineScaleSetExtension",
  VirtualMachineScaleSetExtensionProps,
  {
    /** Name of the extension. */
    extensionName: string;
    /** ARM resource ID of the extension. */
    extensionId: string;
    /** Name of the scale set. */
    virtualMachineScaleSet: string;
    /** Resource group of the scale set. */
    resourceGroup: string;
    /** Extension publisher. */
    publisher: string | undefined;
    /** Extension type. */
    type: string | undefined;
    /** Handler version in the scale set model. */
    typeHandlerVersion: string | undefined;
    /** Provisioning state of the extension in the scale set model. */
    provisioningState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An extension in an Azure virtual machine scale set's model — installed on
 * every instance (existing instances pick it up according to the scale
 * set's upgrade policy).
 *
 * Use either this resource or an inline extension profile on the scale set,
 * not both. Scale set extensions have no tags; ownership follows the
 * parent scale set's Alchemy tags.
 *
 * @see https://learn.microsoft.com/azure/virtual-machine-scale-sets/virtual-machine-scale-sets-deploy-app
 *
 * ### Running a Script on Every Instance
 * **Example:** Custom Script extension
 * ```typescript
 * yield* Azure.Compute.VirtualMachineScaleSetExtension("bootstrap", {
 *   resourceGroup: group.resourceGroupName,
 *   virtualMachineScaleSet: scaleSet.virtualMachineScaleSetName,
 *   publisher: "Microsoft.Azure.Extensions",
 *   type: "CustomScript",
 *   typeHandlerVersion: "2.1",
 *   settings: { commandToExecute: "apt-get install -y nginx" },
 * });
 * ```
 *
 * ### Health Probes
 * **Example:** Application health extension
 * ```typescript
 * yield* Azure.Compute.VirtualMachineScaleSetExtension("health", {
 *   resourceGroup: group.resourceGroupName,
 *   virtualMachineScaleSet: scaleSet.virtualMachineScaleSetName,
 *   publisher: "Microsoft.ManagedServices",
 *   type: "ApplicationHealthLinux",
 *   typeHandlerVersion: "1.0",
 *   settings: { protocol: "http", port: 80, requestPath: "/healthz" },
 * });
 * ```
 *
 * @resource
 */
export const VirtualMachineScaleSetExtension =
  Resource<VirtualMachineScaleSetExtension>(
    "Azure.Compute.VirtualMachineScaleSetExtension",
  );

type Observed = compute.GetVirtualMachineScaleSetExtensionResponse;

const getExtension = (
  subscriptionId: string,
  resourceGroupName: string,
  vmScaleSetName: string,
  vmssExtensionName: string,
) =>
  orUndefinedIfNotFound(
    compute.GetVirtualMachineScaleSetExtension({
      subscriptionId,
      resourceGroupName,
      vmScaleSetName,
      vmssExtensionName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  scaleSet: string,
  name: string,
  ext: Observed,
): VirtualMachineScaleSetExtension["Attributes"] => ({
  extensionName: name,
  extensionId: ext.id ?? "",
  virtualMachineScaleSet: scaleSet,
  resourceGroup,
  publisher: ext.properties?.publisher,
  type: ext.properties?.type,
  typeHandlerVersion: ext.properties?.typeHandlerVersion,
  provisioningState: ext.properties?.provisioningState,
});

export const VirtualMachineScaleSetExtensionProvider = () =>
  Provider.succeed(VirtualMachineScaleSetExtension, {
    stables: [
      "extensionName",
      "extensionId",
      "virtualMachineScaleSet",
      "resourceGroup",
    ],

    // Scale set extensions are deleted with their scale set.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameId(news.resourceGroup, output.resourceGroup) ||
        !sameId(news.virtualMachineScaleSet, output.virtualMachineScaleSet) ||
        (news.name !== undefined && news.name !== output.extensionName) ||
        !sameId(news.publisher, output.publisher) ||
        !sameId(news.type, output.type)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const scaleSet =
        output?.virtualMachineScaleSet ?? olds?.virtualMachineScaleSet;
      if (resourceGroup === undefined || scaleSet === undefined) {
        return undefined;
      }
      const name =
        output?.extensionName ?? olds?.name ?? (yield* createComputeName(id));
      const observed = yield* getExtension(
        subscriptionId,
        resourceGroup,
        scaleSet,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, scaleSet, name, observed);
      // No tags on scale set extensions: the parent's stack/stage tags mark
      // ownership.
      const parent = yield* orUndefinedIfNotFound(
        compute.GetVirtualMachineScaleSet({
          subscriptionId,
          resourceGroupName: resourceGroup,
          vmScaleSetName: scaleSet,
        }),
      );
      const { stack, stage } = yield* stackAndStage;
      const owned =
        parent?.tags?.["alchemy::stack"] === stack &&
        parent?.tags?.["alchemy::stage"] === stage;
      return owned ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Compute");
      const resourceGroup = news.resourceGroup;
      const scaleSet = news.virtualMachineScaleSet;
      const name =
        news.name ?? output?.extensionName ?? (yield* createComputeName(id));
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        vmScaleSetName: scaleSet,
        vmssExtensionName: name,
      };
      const label = `scale set extension ${name}`;
      const get = getExtension(subscriptionId, resourceGroup, scaleSet, name);
      const desired = {
        publisher: news.publisher,
        type: news.type,
        typeHandlerVersion: news.typeHandlerVersion,
        autoUpgradeMinorVersion: news.autoUpgradeMinorVersion ?? true,
        enableAutomaticUpgrade: news.enableAutomaticUpgrade,
        settings: news.settings,
        forceUpdateTag: news.forceUpdateTag,
        provisionAfterExtensions: news.provisionAfterExtensions,
        suppressFailures: news.suppressFailures,
      };

      // Observe.
      let observed = yield* get;
      const p = observed?.properties;

      // Ensure, or re-PUT the full definition when anything drifted.
      // Protected settings are write-only: compare them to the last deploy.
      const drifted =
        observed !== undefined &&
        (p?.typeHandlerVersion !== desired.typeHandlerVersion ||
          (p?.autoUpgradeMinorVersion ?? false) !==
            desired.autoUpgradeMinorVersion ||
          (desired.enableAutomaticUpgrade !== undefined &&
            (p?.enableAutomaticUpgrade ?? false) !==
              desired.enableAutomaticUpgrade) ||
          canonical(p?.settings ?? {}) !== canonical(desired.settings ?? {}) ||
          (p?.forceUpdateTag ?? undefined) !== desired.forceUpdateTag ||
          canonical(p?.provisionAfterExtensions ?? []) !==
            canonical(desired.provisionAfterExtensions ?? []) ||
          (desired.suppressFailures !== undefined &&
            (p?.suppressFailures ?? false) !== desired.suppressFailures) ||
          protectedKey(olds?.protectedSettings) !==
            protectedKey(news.protectedSettings) ||
          p?.provisioningState === "Failed");
      if (observed === undefined || drifted) {
        yield* compute
          .VirtualMachineScaleSetExtensionsCreateOrUpdate({
            ...where,
            name,
            properties: {
              ...desired,
              protectedSettings:
                news.protectedSettings === undefined
                  ? undefined
                  : Redacted.value(news.protectedSettings),
            },
          })
          .pipe(Effect.retry(whileComputeBusy));
      }
      observed = yield* waitComputeProvisioned(label, get);
      return toAttrs(resourceGroup, scaleSet, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        compute.DeleteVirtualMachineScaleSetExtension({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          vmScaleSetName: output.virtualMachineScaleSet,
          vmssExtensionName: output.extensionName,
        }),
      ).pipe(Effect.retry(whileComputeBusy));
      yield* waitComputeGone(
        `scale set extension ${output.extensionName}`,
        getExtension(
          subscriptionId,
          output.resourceGroup,
          output.virtualMachineScaleSet,
          output.extensionName,
        ),
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Compute.VirtualMachineScaleSet",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
