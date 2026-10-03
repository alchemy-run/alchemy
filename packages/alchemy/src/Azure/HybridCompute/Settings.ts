import * as hybridcompute from "@distilled.cloud/azure/hybridcompute";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

export interface SettingsProps {
  /**
   * Resource group of the Arc resource the settings apply to. Changing it
   * replaces the settings.
   */
  resourceGroup: string;
  /**
   * Name of the Arc resource (usually an Arc machine) the settings apply
   * to. Changing it replaces the settings.
   */
  machineName: string;
  /**
   * Resource provider of the base resource. Changing it replaces the
   * settings.
   * @default "Microsoft.HybridCompute"
   */
  baseProvider?: string;
  /**
   * Resource type of the base resource. Changing it replaces the settings.
   * @default "machines"
   */
  baseResourceType?: string;
  /**
   * ARM ID of the `HybridCompute.Gateway` the machine routes its Azure Arc
   * traffic through. Omit to route traffic directly.
   */
  gatewayResourceId?: string;
}

export interface Settings extends Resource<
  "Azure.HybridCompute.Settings",
  SettingsProps,
  {
    /** Resource group of the base resource. */
    resourceGroup: string;
    /** Name of the base resource. */
    machineName: string;
    /** Resource provider of the base resource. */
    baseProvider: string;
    /** Resource type of the base resource. */
    baseResourceType: string;
    /** ARM resource ID of the settings. */
    settingsId: string;
    /** Associated gateway, if any. */
    gatewayResourceId: string | undefined;
    /** Tenant of the base resource. */
    tenantId: string | undefined;
  },
  never,
  Providers
> {}

/**
 * Azure Arc settings of an Arc-enabled server — currently the association
 * with an Azure Arc `Gateway`. Every machine has exactly one settings
 * resource (`default`); declaring it configures it, and destroying it
 * clears the gateway association.
 *
 * @see https://learn.microsoft.com/azure/azure-arc/servers/arc-gateway
 *
 * ### Associating a Gateway
 * **Example:** Route a machine through an Arc gateway
 * ```typescript
 * const gateway = yield* Azure.HybridCompute.Gateway("arc-gateway", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * yield* Azure.HybridCompute.Settings("web-01-settings", {
 *   resourceGroup: group.resourceGroupName,
 *   machineName: machine.machineName,
 *   gatewayResourceId: gateway.gatewayResourceId,
 * });
 * ```
 *
 * @resource
 */
export const Settings = Resource<Settings>("Azure.HybridCompute.Settings");

const SETTINGS_NAME = "default";

interface Target {
  readonly resourceGroup: string;
  readonly machineName: string;
  readonly baseProvider: string;
  readonly baseResourceType: string;
}

const request = (subscriptionId: string, target: Target) => ({
  subscriptionId,
  resourceGroupName: target.resourceGroup,
  baseProvider: target.baseProvider,
  baseResourceType: target.baseResourceType,
  baseResourceName: target.machineName,
  settingsResourceName: SETTINGS_NAME,
});

const getSettings = (subscriptionId: string, target: Target) =>
  orUndefinedIfNotFound(
    hybridcompute.GetSettings(request(subscriptionId, target)),
  );

const toAttrs = (
  target: Target,
  settings:
    | hybridcompute.GetSettingsResponse
    | hybridcompute.PatchSettingsResponse,
): Settings["Attributes"] => ({
  resourceGroup: target.resourceGroup,
  machineName: target.machineName,
  baseProvider: target.baseProvider,
  baseResourceType: target.baseResourceType,
  settingsId: settings.id ?? "",
  gatewayResourceId:
    settings.properties?.gatewayProperties?.gatewayResourceId || undefined,
  tenantId: settings.properties?.tenantId,
});

const targetOf = (props: SettingsProps): Target => ({
  resourceGroup: props.resourceGroup,
  machineName: props.machineName,
  baseProvider: props.baseProvider ?? "Microsoft.HybridCompute",
  baseResourceType: props.baseResourceType ?? "machines",
});

const differs = (a: string | undefined, b: string | undefined) =>
  (a ?? "").toLowerCase() !== (b ?? "").toLowerCase();

export const SettingsProvider = () =>
  Provider.succeed(Settings, {
    stables: [
      "resourceGroup",
      "machineName",
      "baseProvider",
      "baseResourceType",
      "settingsId",
    ],

    // Settings are a singleton of their base resource.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const target = targetOf(news);
      if (
        differs(target.resourceGroup, output.resourceGroup) ||
        differs(target.machineName, output.machineName) ||
        differs(target.baseProvider, output.baseProvider) ||
        differs(target.baseResourceType, output.baseResourceType)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    // The singleton exists as long as its base resource does and carries
    // no ownership marker, so it is always reported as owned.
    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const target =
        output ??
        (olds?.resourceGroup && olds.machineName ? targetOf(olds) : undefined);
      if (target === undefined) return undefined;
      const observed = yield* getSettings(subscriptionId, target);
      return observed === undefined ? undefined : toAttrs(target, observed);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.HybridCompute");
      const target = targetOf(news);

      // Observe.
      let observed = yield* getSettings(subscriptionId, target);

      // Sync the gateway association (the singleton always exists).
      if (
        observed === undefined ||
        differs(
          observed.properties?.gatewayProperties?.gatewayResourceId,
          news.gatewayResourceId,
        )
      ) {
        observed = yield* hybridcompute.PatchSettings2({
          ...request(subscriptionId, target),
          properties: {
            gatewayProperties: {
              gatewayResourceId: news.gatewayResourceId ?? "",
            },
          },
        });
      }

      return toAttrs(target, observed);
    }),

    // No DELETE exists: clear the gateway association instead. A missing
    // base resource means there is nothing to clear.
    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const observed = yield* getSettings(subscriptionId, output);
      if (observed?.properties?.gatewayProperties?.gatewayResourceId) {
        yield* ignoreNotFound(
          hybridcompute.PatchSettings2({
            ...request(subscriptionId, output),
            properties: { gatewayProperties: { gatewayResourceId: "" } },
          }),
        );
      }
    }),

    nuke: {
      dependsOn: [
        "Azure.Resources.ResourceGroup",
        "Azure.HybridCompute.Machine",
      ],
    },
  });
