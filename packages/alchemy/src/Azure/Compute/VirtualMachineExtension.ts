import * as compute from "@distilled.cloud/azure/compute";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  tagsDiffer,
  userTags,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  canonical,
  createComputeName,
  protectedKey,
  sameId,
  waitComputeGone,
  vmLocation,
  waitComputeProvisioned,
  whileComputeBusy,
} from "./common.ts";

export interface VirtualMachineExtensionProps {
  /**
   * Resource group of the VM. Changing it replaces the extension.
   */
  resourceGroup: string;
  /**
   * Name of the VM the extension is installed on. Changing it replaces the
   * extension.
   */
  virtualMachine: string;
  /**
   * Name of the extension instance. If omitted, a unique name is generated
   * from the app, stage, and logical ID. Changing it replaces the
   * extension.
   */
  name?: string;
  /**
   * Location of the VM.
   * @default the VM's location
   */
  location?: string;
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
   * Do not fail the VM deployment when the extension fails.
   * @default false
   */
  suppressFailures?: boolean;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface VirtualMachineExtension extends Resource<
  "Azure.Compute.VirtualMachineExtension",
  VirtualMachineExtensionProps,
  {
    /** Name of the extension instance. */
    extensionName: string;
    /** ARM resource ID of the extension. */
    extensionId: string;
    /** Name of the VM. */
    virtualMachine: string;
    /** Resource group of the VM. */
    resourceGroup: string;
    /** Location of the extension. */
    location: string;
    /** Extension publisher. */
    publisher: string | undefined;
    /** Extension type. */
    type: string | undefined;
    /** Installed handler version. */
    typeHandlerVersion: string | undefined;
    /** Provisioning state (`Succeeded` once the deploy returns). */
    provisioningState: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An extension installed on an Azure virtual machine — e.g. the Custom
 * Script extension, the Azure Monitor agent, or Key Vault certificate sync.
 * The deploy waits until the extension has run; a failing extension fails
 * the deploy (unless `suppressFailures` is set).
 *
 * @see https://learn.microsoft.com/azure/virtual-machines/extensions/overview
 *
 * ### Running a Script
 * **Example:** Custom Script extension on Linux
 * ```typescript
 * const script = yield* Azure.Compute.VirtualMachineExtension("bootstrap", {
 *   resourceGroup: group.resourceGroupName,
 *   virtualMachine: vm.virtualMachineName,
 *   publisher: "Microsoft.Azure.Extensions",
 *   type: "CustomScript",
 *   typeHandlerVersion: "2.1",
 *   settings: { commandToExecute: "apt-get update && apt-get install -y nginx" },
 * });
 * ```
 *
 * **Example:** Script with secret settings
 * ```typescript
 * const script = yield* Azure.Compute.VirtualMachineExtension("bootstrap", {
 *   resourceGroup: group.resourceGroupName,
 *   virtualMachine: vm.virtualMachineName,
 *   publisher: "Microsoft.Azure.Extensions",
 *   type: "CustomScript",
 *   typeHandlerVersion: "2.1",
 *   protectedSettings: Redacted.make({
 *     commandToExecute: `echo ${token} > /etc/app-token`,
 *   }),
 * });
 * ```
 *
 * ### Monitoring
 * **Example:** Azure Monitor agent
 * ```typescript
 * yield* Azure.Compute.VirtualMachineExtension("monitor", {
 *   resourceGroup: group.resourceGroupName,
 *   virtualMachine: vm.virtualMachineName,
 *   publisher: "Microsoft.Azure.Monitor",
 *   type: "AzureMonitorLinuxAgent",
 *   typeHandlerVersion: "1.0",
 *   enableAutomaticUpgrade: true,
 * });
 * ```
 *
 * @resource
 */
export const VirtualMachineExtension = Resource<VirtualMachineExtension>(
  "Azure.Compute.VirtualMachineExtension",
);

type Observed = compute.GetVirtualMachineExtensionResponse;

const getExtension = (
  subscriptionId: string,
  resourceGroupName: string,
  vmName: string,
  vmExtensionName: string,
) =>
  orUndefinedIfNotFound(
    compute.GetVirtualMachineExtension({
      subscriptionId,
      resourceGroupName,
      vmName,
      vmExtensionName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  vmName: string,
  name: string,
  ext: Observed,
): VirtualMachineExtension["Attributes"] => ({
  extensionName: name,
  extensionId: ext.id ?? "",
  virtualMachine: vmName,
  resourceGroup,
  location: ext.location,
  publisher: ext.properties?.publisher,
  type: ext.properties?.type,
  typeHandlerVersion: ext.properties?.typeHandlerVersion,
  provisioningState: ext.properties?.provisioningState,
  tags: userTags(ext.tags),
});

export const VirtualMachineExtensionProvider = () =>
  Provider.succeed(VirtualMachineExtension, {
    stables: [
      "extensionName",
      "extensionId",
      "virtualMachine",
      "resourceGroup",
      "location",
    ],

    // Extensions are deleted with their VM.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameId(news.resourceGroup, output.resourceGroup) ||
        !sameId(news.virtualMachine, output.virtualMachine) ||
        (news.name !== undefined && news.name !== output.extensionName) ||
        (news.location !== undefined &&
          !sameId(news.location, output.location)) ||
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
      const vmName = output?.virtualMachine ?? olds?.virtualMachine;
      if (resourceGroup === undefined || vmName === undefined) return undefined;
      const name =
        output?.extensionName ?? olds?.name ?? (yield* createComputeName(id));
      const observed = yield* getExtension(
        subscriptionId,
        resourceGroup,
        vmName,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, vmName, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Compute");
      const resourceGroup = news.resourceGroup;
      const vmName = news.virtualMachine;
      const name =
        news.name ?? output?.extensionName ?? (yield* createComputeName(id));
      const location =
        news.location ??
        output?.location ??
        (yield* vmLocation(subscriptionId, resourceGroup, vmName)) ??
        env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        vmName,
        vmExtensionName: name,
      };
      const label = `VM extension ${name}`;
      const get = getExtension(subscriptionId, resourceGroup, vmName, name);
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
      const protectedSettings =
        news.protectedSettings === undefined
          ? undefined
          : Redacted.value(news.protectedSettings);

      // Observe.
      let observed = yield* get;
      const p = observed?.properties;

      // Ensure, or re-PUT the full definition when any setting drifted.
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
          (desired.suppressFailures !== undefined &&
            (p?.suppressFailures ?? false) !== desired.suppressFailures) ||
          protectedKey(olds?.protectedSettings) !==
            protectedKey(news.protectedSettings) ||
          p?.provisioningState === "Failed");
      if (observed === undefined || drifted) {
        yield* compute
          .VirtualMachineExtensionsCreateOrUpdate({
            ...where,
            location,
            tags,
            properties: { ...desired, protectedSettings },
          })
          .pipe(Effect.retry(whileComputeBusy));
      }
      observed = yield* waitComputeProvisioned(label, get);

      // Sync tags.
      if (tagsDiffer(observed.tags, tags)) {
        yield* compute
          .UpdateVirtualMachineExtension({ ...where, tags })
          .pipe(Effect.retry(whileComputeBusy));
        observed = yield* waitComputeProvisioned(label, get);
      }
      return toAttrs(resourceGroup, vmName, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        compute.DeleteVirtualMachineExtension({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          vmName: output.virtualMachine,
          vmExtensionName: output.extensionName,
        }),
      ).pipe(Effect.retry(whileComputeBusy));
      yield* waitComputeGone(
        `VM extension ${output.extensionName}`,
        getExtension(
          subscriptionId,
          output.resourceGroup,
          output.virtualMachine,
          output.extensionName,
        ),
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Compute.VirtualMachine",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
