import * as hybridcompute from "@distilled.cloud/azure/hybridcompute";
import * as Effect from "effect/Effect";
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
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { machineLocation } from "./MachineCommon.ts";

export interface MachineExtensionProps {
  /** Resource group of the Arc machine. Changing it replaces the extension. */
  resourceGroup: string;
  /** Name of the Arc machine. Changing it replaces the extension. */
  machineName: string;
  /**
   * Name of the extension. Changing it replaces the extension.
   * @default the extension `type`
   */
  name?: string;
  /**
   * Azure location; must match the machine's location. Changing it
   * replaces the extension.
   * @default the machine's location
   */
  location?: string;
  /**
   * Publisher of the extension handler, e.g. `Microsoft.Azure.Monitor`.
   * Changing it replaces the extension.
   */
  publisher: string;
  /**
   * Type of the extension, e.g. `AzureMonitorLinuxAgent` or
   * `CustomScript`. Changing it replaces the extension.
   */
  type: string;
  /** Version of the extension handler, e.g. `1.0`. */
  typeHandlerVersion?: string;
  /**
   * Whether to use a newer minor version when one is available at
   * deployment time.
   */
  autoUpgradeMinorVersion?: boolean;
  /**
   * Whether the platform upgrades the extension automatically when a newer
   * version is published.
   */
  enableAutomaticUpgrade?: boolean;
  /** Public JSON settings for the extension. */
  settings?: Record<string, unknown>;
  /**
   * Protected JSON settings, encrypted on the machine and never returned
   * by Azure.
   */
  protectedSettings?: Record<string, unknown>;
  /**
   * Change this value to force the extension handler to re-run even if its
   * configuration is unchanged.
   */
  forceUpdateTag?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface MachineExtension extends Resource<
  "Azure.HybridCompute.MachineExtension",
  MachineExtensionProps,
  {
    /** Name of the extension. */
    extensionName: string;
    /** Name of the Arc machine. */
    machineName: string;
    /** Resource group of the Arc machine. */
    resourceGroup: string;
    /** ARM resource ID of the extension. */
    extensionId: string;
    /** Location of the extension. */
    location: string;
    /** Publisher of the extension handler. */
    publisher: string | undefined;
    /** Type of the extension. */
    type: string | undefined;
    /** Installed handler version. */
    typeHandlerVersion: string | undefined;
    /** Provisioning state reported by Azure. */
    provisioningState: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A VM extension installed on an Azure Arc-enabled server — for example
 * the Azure Monitor agent, Defender for Endpoint, or a custom script.
 *
 * The machine must be connected (`status: "Connected"`): the Connected
 * Machine agent downloads and runs the extension.
 *
 * @see https://learn.microsoft.com/azure/azure-arc/servers/manage-vm-extensions
 *
 * ### Installing Extensions
 * **Example:** Azure Monitor agent on a Linux server
 * ```typescript
 * yield* Azure.HybridCompute.MachineExtension("monitor", {
 *   resourceGroup: "arc",
 *   machineName: "web-01",
 *   publisher: "Microsoft.Azure.Monitor",
 *   type: "AzureMonitorLinuxAgent",
 *   enableAutomaticUpgrade: true,
 * });
 * ```
 *
 * **Example:** Custom script
 * ```typescript
 * yield* Azure.HybridCompute.MachineExtension("bootstrap", {
 *   resourceGroup: "arc",
 *   machineName: "web-01",
 *   publisher: "Microsoft.Azure.Extensions",
 *   type: "CustomScript",
 *   typeHandlerVersion: "2.1",
 *   settings: { commandToExecute: "echo hello > /tmp/hello" },
 * });
 * ```
 *
 * @resource
 */
export const MachineExtension = Resource<MachineExtension>(
  "Azure.HybridCompute.MachineExtension",
);

type ObservedExtension = hybridcompute.GetMachineExtensionResponse;

const getExtension = (
  subscriptionId: string,
  resourceGroupName: string,
  machineName: string,
  extensionName: string,
) =>
  orUndefinedIfNotFound(
    hybridcompute.GetMachineExtension({
      subscriptionId,
      resourceGroupName,
      machineName,
      extensionName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  machineName: string,
  name: string,
  extension: ObservedExtension,
): MachineExtension["Attributes"] => ({
  extensionName: name,
  machineName,
  resourceGroup,
  extensionId: extension.id ?? "",
  location: extension.location,
  publisher: extension.properties?.publisher,
  type: extension.properties?.type,
  typeHandlerVersion: extension.properties?.typeHandlerVersion,
  provisioningState: extension.properties?.provisioningState,
  tags: userTags(extension.tags),
});

const differs = (a: string | undefined, b: string | undefined) =>
  (a ?? "").toLowerCase() !== (b ?? "").toLowerCase();

const json = (value: unknown) => JSON.stringify(value ?? {});

// Extension installs run on the host and can take several minutes.
const budget = { interval: "10 seconds", times: 60 } as const;

export const MachineExtensionProvider = () =>
  Provider.succeed(MachineExtension, {
    stables: [
      "extensionName",
      "machineName",
      "resourceGroup",
      "extensionId",
      "location",
    ],

    // Extensions are deleted with their machine.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        differs(news.resourceGroup, output.resourceGroup) ||
        differs(news.machineName, output.machineName) ||
        differs(news.name ?? news.type, output.extensionName) ||
        (news.location !== undefined &&
          differs(news.location, output.location)) ||
        differs(news.publisher, output.publisher) ||
        differs(news.type, output.type)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const machineName = output?.machineName ?? olds?.machineName;
      const name = output?.extensionName ?? olds?.name ?? olds?.type;
      if (
        resourceGroup === undefined ||
        machineName === undefined ||
        name === undefined
      ) {
        return undefined;
      }
      const observed = yield* getExtension(
        subscriptionId,
        resourceGroup,
        machineName,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, machineName, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.HybridCompute");
      const resourceGroup = news.resourceGroup;
      const machineName = news.machineName;
      const name = news.name ?? news.type;
      const tags = yield* desiredTags(id, news.tags);
      const label = `arc machine extension ${machineName}/${name}`;
      const get = getExtension(
        subscriptionId,
        resourceGroup,
        machineName,
        name,
      );

      // Observe.
      let observed = yield* get;
      const props = observed?.properties;

      // Ensure + sync: the PUT upserts the whole extension. Protected
      // settings are never returned, so the previous props are the only
      // hint that they changed.
      if (
        observed === undefined ||
        props?.provisioningState === "Failed" ||
        (news.typeHandlerVersion !== undefined &&
          !(props?.typeHandlerVersion ?? "").startsWith(
            news.typeHandlerVersion,
          )) ||
        (news.autoUpgradeMinorVersion !== undefined &&
          props?.autoUpgradeMinorVersion !== news.autoUpgradeMinorVersion) ||
        (news.enableAutomaticUpgrade !== undefined &&
          props?.enableAutomaticUpgrade !== news.enableAutomaticUpgrade) ||
        json(props?.settings) !== json(news.settings) ||
        (props?.forceUpdateTag ?? "") !== (news.forceUpdateTag ?? "") ||
        json(olds?.protectedSettings) !== json(news.protectedSettings) ||
        tagsDiffer(observed.tags, tags)
      ) {
        const location =
          news.location ??
          observed?.location ??
          output?.location ??
          (yield* machineLocation(subscriptionId, resourceGroup, machineName));
        yield* hybridcompute.MachineExtensionsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          machineName,
          extensionName: name,
          location,
          tags,
          properties: {
            publisher: news.publisher,
            type: news.type,
            typeHandlerVersion: news.typeHandlerVersion,
            autoUpgradeMinorVersion: news.autoUpgradeMinorVersion,
            enableAutomaticUpgrade: news.enableAutomaticUpgrade,
            settings: news.settings,
            protectedSettings: news.protectedSettings,
            forceUpdateTag: news.forceUpdateTag,
          },
        });
      }
      observed = yield* waitForProvisioned(
        label,
        get,
        (extension) => extension.properties?.provisioningState,
        budget,
      );

      return toAttrs(resourceGroup, machineName, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        hybridcompute.DeleteMachineExtension({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          machineName: output.machineName,
          extensionName: output.extensionName,
        }),
      );
      yield* waitUntilGone(
        `arc machine extension ${output.machineName}/${output.extensionName}`,
        getExtension(
          subscriptionId,
          output.resourceGroup,
          output.machineName,
          output.extensionName,
        ),
        budget,
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Resources.ResourceGroup",
        "Azure.HybridCompute.Machine",
      ],
    },
  });
