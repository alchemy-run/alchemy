import * as compute from "@distilled.cloud/azure/compute";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { ensureRegistered, ignoreNotFound, orUndefinedIfNotFound, stackAndStage } from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import {
  canonical,
  createComputeName,
  protectedKey,
  sameId,
  scaleSetLocation,
  waitComputeGone,
  waitComputeProvisioned,
  whileComputeBusy,
} from "./common.ts";

export interface VirtualMachineScaleSetVMExtensionProps {
  /**
   * Resource group of the scale set. Changing it replaces the extension.
   */
  resourceGroup: string;
  /**
   * Name of the `Uniform` scale set. Changing it replaces the extension.
   */
  virtualMachineScaleSet: string;
  /**
   * Instance ID of the scale set VM the extension is installed on, e.g.
   * `"0"` (see the scale set's `instanceIds`). Changing it replaces the
   * extension.
   */
  instanceId: string;
  /**
   * Name of the extension instance. If omitted, a unique name is generated
   * from the app, stage, and logical ID. Changing it replaces the
   * extension.
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
   * Do not fail the deployment when the extension fails.
   * @default false
   */
  suppressFailures?: boolean;
}

export interface VirtualMachineScaleSetVMExtension extends Resource<
  "Azure.Compute.VirtualMachineScaleSetVMExtension",
  VirtualMachineScaleSetVMExtensionProps,
  {
    /** Name of the extension instance. */
    extensionName: string;
    /** ARM resource ID of the extension. */
    extensionId: string;
    /** Name of the scale set. */
    virtualMachineScaleSet: string;
    /** Instance ID of the scale set VM. */
    instanceId: string;
    /** Resource group of the scale set. */
    resourceGroup: string;
    /** Extension publisher. */
    publisher: string | undefined;
    /** Extension type. */
    type: string | undefined;
    /** Installed handler version. */
    typeHandlerVersion: string | undefined;
    /** Provisioning state (`Succeeded` once the deploy returns). */
    provisioningState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An extension installed on one VM of a `Uniform` Azure virtual machine
 * scale set (ARM type
 * `Microsoft.Compute/virtualMachineScaleSets/virtualMachines/extensions`).
 * Use it for an extension that only one instance needs; extensions every
 * instance needs belong in the scale set model
 * (`Azure.Compute.VirtualMachineScaleSetExtension`). The deploy waits
 * until the extension has run; a failing extension fails the deploy
 * (unless `suppressFailures` is set).
 *
 * `Flexible` scale set instances are regular VMs: use
 * `Azure.Compute.VirtualMachineExtension` on them instead. Instance
 * extensions carry no tags, so ownership follows the scale set's
 * `alchemy::stack` and `alchemy::stage` tags.
 *
 * :::caution
 * Changing `resourceGroup`, `virtualMachineScaleSet`, `instanceId`, `name`,
 * `publisher`, or `type` replaces the extension. Deleting the instance
 * (scale-in) deletes its extensions.
 * :::
 *
 * @see https://learn.microsoft.com/azure/virtual-machine-scale-sets/virtual-machine-scale-sets-extension-sequencing
 *
 * ### Running a Script
 * **Example:** Custom Script extension on the first instance
 * ```typescript
 * const scaleSet = yield* Azure.Compute.VirtualMachineScaleSet("batch", {
 *   orchestrationMode: "Uniform",
 *   vmSize: "Standard_D2s_v5",
 *   subnetId: subnet.subnetId,
 *   adminUsername: "azureuser",
 *   sshPublicKeys: [publicKey],
 * });
 * yield* Azure.Compute.VirtualMachineScaleSetVMExtension("bootstrap", {
 *   virtualMachineScaleSet: scaleSet.virtualMachineScaleSetName,
 *   instanceId: "0",
 *   publisher: "Microsoft.Azure.Extensions",
 *   type: "CustomScript",
 *   typeHandlerVersion: "2.1",
 *   settings: { commandToExecute: "apt-get update && apt-get install -y nginx" },
 * });
 * ```
 *
 * **Example:** Script with secret settings
 * ```typescript
 * yield* Azure.Compute.VirtualMachineScaleSetVMExtension("bootstrap", {
 *   virtualMachineScaleSet: scaleSet.virtualMachineScaleSetName,
 *   instanceId: "0",
 *   publisher: "Microsoft.Azure.Extensions",
 *   type: "CustomScript",
 *   typeHandlerVersion: "2.1",
 *   protectedSettings: Redacted.make({
 *     commandToExecute: `echo ${token} > /etc/app-token`,
 *   }),
 * });
 * ```
 *
 * @resource
 */
export const VirtualMachineScaleSetVMExtension = GroupedResource<VirtualMachineScaleSetVMExtension>(
  "Azure.Compute.VirtualMachineScaleSetVMExtension",
);

type Observed = compute.GetVirtualMachineScaleSetVMExtensionResponse;

interface Where {
  readonly subscriptionId: string;
  readonly resourceGroupName: string;
  readonly vmScaleSetName: string;
  readonly instanceId: string;
  readonly vmExtensionName: string;
}

const getExtension = (where: Where) =>
  orUndefinedIfNotFound(compute.GetVirtualMachineScaleSetVMExtension(where));

const toAttrs = (
  resourceGroup: string,
  scaleSet: string,
  instanceId: string,
  name: string,
  ext: Observed,
): VirtualMachineScaleSetVMExtension["Attributes"] => ({
  extensionName: name,
  extensionId: ext.id ?? "",
  virtualMachineScaleSet: scaleSet,
  instanceId,
  resourceGroup,
  publisher: ext.properties?.publisher,
  type: ext.properties?.type,
  typeHandlerVersion: ext.properties?.typeHandlerVersion,
  provisioningState: ext.properties?.provisioningState,
});

export const VirtualMachineScaleSetVMExtensionProvider = () =>
  Provider.succeed(VirtualMachineScaleSetVMExtension, {
    stables: [
      "extensionName",
      "extensionId",
      "virtualMachineScaleSet",
      "instanceId",
      "resourceGroup",
    ],

    // Instance extensions are deleted with their scale set instance.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameId(news.resourceGroup, output.resourceGroup) ||
        !sameId(news.virtualMachineScaleSet, output.virtualMachineScaleSet) ||
        news.instanceId !== output.instanceId ||
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
      const scaleSet = output?.virtualMachineScaleSet ?? olds?.virtualMachineScaleSet;
      const instanceId = output?.instanceId ?? olds?.instanceId;
      if (resourceGroup === undefined || scaleSet === undefined || instanceId === undefined) {
        return undefined;
      }
      const name = output?.extensionName ?? olds?.name ?? (yield* createComputeName(id));
      const observed = yield* getExtension({
        subscriptionId,
        resourceGroupName: resourceGroup,
        vmScaleSetName: scaleSet,
        instanceId,
        vmExtensionName: name,
      });
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, scaleSet, instanceId, name, observed);
      // No tags on instance extensions: the parent's stack/stage tags mark
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
        parent?.tags?.["alchemy::stack"] === stack && parent?.tags?.["alchemy::stage"] === stage;
      return owned ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Compute");
      const resourceGroup = news.resourceGroup;
      const scaleSet = news.virtualMachineScaleSet;
      const instanceId = news.instanceId;
      const name = news.name ?? output?.extensionName ?? (yield* createComputeName(id));
      const location =
        (yield* scaleSetLocation(subscriptionId, resourceGroup, scaleSet)) ?? env.location;
      const where: Where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        vmScaleSetName: scaleSet,
        instanceId,
        vmExtensionName: name,
      };
      const label = `scale set VM extension ${name}`;
      const get = getExtension(where);
      const desired = {
        publisher: news.publisher,
        type: news.type,
        typeHandlerVersion: news.typeHandlerVersion,
        autoUpgradeMinorVersion: news.autoUpgradeMinorVersion ?? true,
        enableAutomaticUpgrade: news.enableAutomaticUpgrade,
        settings: news.settings,
        forceUpdateTag: news.forceUpdateTag,
        suppressFailures: news.suppressFailures,
      };

      // Observe.
      let observed = yield* get;
      const p = observed?.properties;

      // Ensure, or re-PUT the full definition when any setting drifted.
      // Protected settings are write-only: compare them to the last deploy.
      const drifted =
        observed !== undefined &&
        (p?.typeHandlerVersion !== desired.typeHandlerVersion ||
          (p?.autoUpgradeMinorVersion ?? false) !== desired.autoUpgradeMinorVersion ||
          (desired.enableAutomaticUpgrade !== undefined &&
            (p?.enableAutomaticUpgrade ?? false) !== desired.enableAutomaticUpgrade) ||
          canonical(p?.settings ?? {}) !== canonical(desired.settings ?? {}) ||
          (p?.forceUpdateTag ?? undefined) !== desired.forceUpdateTag ||
          (desired.suppressFailures !== undefined &&
            (p?.suppressFailures ?? false) !== desired.suppressFailures) ||
          protectedKey(olds?.protectedSettings) !== protectedKey(news.protectedSettings) ||
          p?.provisioningState === "Failed");
      if (observed === undefined || drifted) {
        yield* compute
          .VirtualMachineScaleSetVMExtensionsCreateOrUpdate({
            ...where,
            location,
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
      return toAttrs(resourceGroup, scaleSet, instanceId, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const where: Where = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        vmScaleSetName: output.virtualMachineScaleSet,
        instanceId: output.instanceId,
        vmExtensionName: output.extensionName,
      };
      yield* ignoreNotFound(compute.DeleteVirtualMachineScaleSetVMExtension(where)).pipe(
        Effect.retry(whileComputeBusy),
      );
      yield* waitComputeGone(`scale set VM extension ${output.extensionName}`, getExtension(where));
    }),

    nuke: {
      dependsOn: ["Azure.Compute.VirtualMachineScaleSet", "Azure.Resources.ResourceGroup"],
    },
  });
