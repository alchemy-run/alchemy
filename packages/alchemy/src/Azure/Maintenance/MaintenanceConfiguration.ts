import * as maintenance from "@distilled.cloud/azure/maintenance";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

/** What a maintenance configuration controls. */
export type MaintenanceScope =
  | "Host"
  | "Resource"
  | "OSImage"
  | "Extension"
  | "InGuestPatch"
  | "SQLDB"
  | "SQLManagedInstance";

/** The recurring window in which maintenance may run. */
export interface MaintenanceWindow {
  /**
   * Effective start of the window in `YYYY-MM-DD hh:mm` format, in
   * `timeZone`. Must be the current date or a future date.
   */
  startDateTime: string;
  /**
   * Expiration of the window in `YYYY-MM-DD hh:mm` format. Must be in the
   * future.
   * @default 9999-12-31 23:59
   */
  expirationDateTime?: string;
  /**
   * Duration of the window in `HH:mm` format, e.g. `"03:55"`.
   * @default a scope-specific default
   */
  duration?: string;
  /**
   * Windows time zone name, e.g. `"UTC"` or `"Pacific Standard Time"`.
   */
  timeZone: string;
  /**
   * Recurrence, e.g. `"Day"`, `"3Days"`, `"Week Saturday,Sunday"`,
   * `"Month Last Sunday"`, `"Month day23,day24"`.
   */
  recurEvery?: string;
}

/** Windows patching parameters of an `InGuestPatch` configuration. */
export interface MaintenanceWindowsPatchParameters {
  /** KB numbers to exclude, e.g. `["KB123456"]`. */
  kbNumbersToExclude?: string[];
  /** KB numbers to include. */
  kbNumbersToInclude?: string[];
  /**
   * Patch classifications to install: `Critical`, `Security`,
   * `UpdateRollup`, `FeaturePack`, `ServicePack`, `Definition`, `Tools`,
   * `Updates`.
   */
  classificationsToInclude?: string[];
  /** Skip patches that require a reboot. */
  excludeKbsRequiringReboot?: boolean;
}

/** Linux patching parameters of an `InGuestPatch` configuration. */
export interface MaintenanceLinuxPatchParameters {
  /** Package name masks to exclude, e.g. `["kernel*"]`. */
  packageNameMasksToExclude?: string[];
  /** Package name masks to include. */
  packageNameMasksToInclude?: string[];
  /** Patch classifications to install: `Critical`, `Security`, `Other`. */
  classificationsToInclude?: string[];
}

/** Patches installed during an `InGuestPatch` maintenance run. */
export interface MaintenanceInstallPatches {
  /** Reboot behaviour after patching: `IfRequired`, `Never`, or `Always`. */
  rebootSetting?: "IfRequired" | "Never" | "Always";
  /** Windows-only patch parameters. */
  windowsParameters?: MaintenanceWindowsPatchParameters;
  /** Linux-only patch parameters. */
  linuxParameters?: MaintenanceLinuxPatchParameters;
}

export interface MaintenanceConfigurationProps {
  /**
   * Resource group the configuration is created in. Changing it replaces
   * the configuration.
   */
  resourceGroup: string;
  /**
   * Name of the configuration. If omitted, a unique name is generated from
   * the app, stage, and logical ID. Keep the resource group and name within
   * ~128 characters combined; the service fails longer resource IDs with an
   * internal server error. Changing it replaces the configuration.
   */
  name?: string;
  /**
   * Azure location of the configuration. Changing it replaces the
   * configuration.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * What the configuration controls, e.g. `InGuestPatch` for scheduled
   * guest OS patching or `Host` for platform updates on dedicated hosts.
   * Changing it replaces the configuration.
   */
  maintenanceScope: MaintenanceScope;
  /** Namespace of the configuration. */
  namespace?: string;
  /**
   * Scope-specific extension properties. `InGuestPatch` requires
   * `{ InGuestPatchMode: "User" }`.
   */
  extensionProperties?: Record<string, string>;
  /** The recurring maintenance window. */
  maintenanceWindow?: MaintenanceWindow;
  /**
   * Visibility of the configuration.
   * @default "Custom"
   */
  visibility?: "Custom" | "Public";
  /** Patches to install (`InGuestPatch` scope only). */
  installPatches?: MaintenanceInstallPatches;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface MaintenanceConfiguration extends Resource<
  "Azure.Maintenance.MaintenanceConfiguration",
  MaintenanceConfigurationProps,
  {
    /** Name of the configuration. */
    maintenanceConfigurationName: string;
    /** ARM resource ID of the configuration. */
    maintenanceConfigurationId: string;
    /** Resource group that holds the configuration. */
    resourceGroup: string;
    /** Location of the configuration. */
    location: string;
    /** What the configuration controls. */
    maintenanceScope: string;
    /** Visibility of the configuration. */
    visibility: string | undefined;
    /** The observed maintenance window. */
    maintenanceWindow: MaintenanceWindow | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Maintenance configuration — a schedule (maintenance window) and
 * settings that control when platform updates, guest OS patches, or SQL
 * maintenance are applied to the resources assigned to it.
 *
 * Assign resources with `Azure.Maintenance.ConfigurationAssignment`.
 *
 * @see https://learn.microsoft.com/azure/virtual-machines/maintenance-configurations
 *
 * ### Scheduled Guest Patching
 * **Example:** Patch Linux VMs daily in a four-hour window
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("ops");
 * const patching = yield* Azure.Maintenance.MaintenanceConfiguration("patching", {
 *   resourceGroup: group.resourceGroupName,
 *   maintenanceScope: "InGuestPatch",
 *   extensionProperties: { InGuestPatchMode: "User" },
 *   maintenanceWindow: {
 *     startDateTime: "2030-01-01 02:00",
 *     duration: "03:55",
 *     timeZone: "UTC",
 *     recurEvery: "Day",
 *   },
 *   installPatches: {
 *     rebootSetting: "IfRequired",
 *     linuxParameters: { classificationsToInclude: ["Critical", "Security"] },
 *   },
 * });
 * ```
 *
 * ### Platform Maintenance
 * **Example:** Weekend window for platform updates
 * ```typescript
 * yield* Azure.Maintenance.MaintenanceConfiguration("platform", {
 *   resourceGroup: group.resourceGroupName,
 *   maintenanceScope: "Host",
 *   maintenanceWindow: {
 *     startDateTime: "2030-01-05 00:00",
 *     duration: "05:00",
 *     timeZone: "Pacific Standard Time",
 *     recurEvery: "Week Saturday,Sunday",
 *   },
 * });
 * ```
 *
 * @resource
 */
export const MaintenanceConfiguration = Resource<MaintenanceConfiguration>(
  "Azure.Maintenance.MaintenanceConfiguration",
);

type ObservedConfiguration = maintenance.GetMaintenanceConfigurationResponse;

const getConfiguration = (
  subscriptionId: string,
  resourceGroupName: string,
  resourceName: string,
) =>
  orUndefinedIfNotFound(
    maintenance.GetMaintenanceConfiguration({
      subscriptionId,
      resourceGroupName,
      resourceName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  config: ObservedConfiguration,
): MaintenanceConfiguration["Attributes"] => {
  const window = config.properties?.maintenanceWindow;
  return {
    maintenanceConfigurationName: name,
    maintenanceConfigurationId: config.id ?? "",
    resourceGroup,
    location: config.location ?? "",
    maintenanceScope: config.properties?.maintenanceScope ?? "",
    visibility: config.properties?.visibility,
    maintenanceWindow:
      window?.startDateTime !== undefined && window.timeZone !== undefined
        ? {
            startDateTime: window.startDateTime,
            expirationDateTime: window.expirationDateTime,
            duration: window.duration,
            timeZone: window.timeZone,
            recurEvery: window.recurEvery,
          }
        : undefined,
    tags: userTags(config.tags),
  };
};

/**
 * True when every field set in `desired` equals the observed value.
 * Fields Azure defaults (and the caller left unset) are ignored.
 */
const covers = (desired: unknown, observed: unknown): boolean => {
  if (desired === undefined) return true;
  if (Array.isArray(desired)) {
    return (
      Array.isArray(observed) &&
      desired.length === observed.length &&
      desired.every((value, i) => covers(value, observed[i]))
    );
  }
  if (typeof desired === "object" && desired !== null) {
    if (typeof observed !== "object" || observed === null) return false;
    return Object.entries(desired).every(([key, value]) =>
      covers(value, (observed as Record<string, unknown>)[key]),
    );
  }
  if (typeof desired === "string" && typeof observed === "string") {
    return desired.toLowerCase() === observed.toLowerCase();
  }
  return desired === observed;
};

const desiredProperties = (news: MaintenanceConfigurationProps) => ({
  maintenanceScope: news.maintenanceScope,
  namespace: news.namespace,
  extensionProperties: news.extensionProperties,
  maintenanceWindow: news.maintenanceWindow,
  visibility: news.visibility ?? "Custom",
  installPatches: news.installPatches,
});

/**
 * Generated name. The Maintenance RP answers 500 when the full resource ID
 * exceeds ~256 characters, so the name shrinks as the resource group name
 * grows (resource group + name stay within 128 characters).
 */
const configurationName = (id: string, resourceGroup: string) =>
  createPhysicalName({
    id,
    maxLength: Math.max(16, Math.min(64, 128 - resourceGroup.length)),
  });

export const MaintenanceConfigurationProvider = () =>
  Provider.succeed(MaintenanceConfiguration, {
    stables: [
      "maintenanceConfigurationName",
      "maintenanceConfigurationId",
      "resourceGroup",
      "location",
      "maintenanceScope",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* orUndefinedIfNotFound(
        maintenance.ListMaintenanceConfigurations({ subscriptionId }),
      );
      return (page?.value ?? []).flatMap((config) => {
        const group = resourceGroupOf(config.id);
        return hasAnyAlchemyTag(config.tags) &&
          group !== undefined &&
          config.name !== undefined
          ? [toAttrs(group, config.name, config)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !==
            output.maintenanceConfigurationName.toLowerCase()) ||
        (news.location !== undefined &&
          news.location.toLowerCase().replaceAll(" ", "") !==
            output.location.toLowerCase().replaceAll(" ", "")) ||
        news.maintenanceScope.toLowerCase() !==
          output.maintenanceScope.toLowerCase()
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.maintenanceConfigurationName ??
        olds?.name ??
        (yield* configurationName(id, resourceGroup));
      const observed = yield* getConfiguration(
        subscriptionId,
        resourceGroup,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Maintenance");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ??
        output?.maintenanceConfigurationName ??
        (yield* configurationName(id, resourceGroup));
      const tags = yield* desiredTags(id, news.tags);
      const properties = desiredProperties(news);

      // Observe.
      let observed = yield* getConfiguration(
        subscriptionId,
        resourceGroup,
        name,
      );

      // Ensure + sync. The PUT is a synchronous full upsert; send it when the
      // configuration is missing, an observed setting or tag differs, or a
      // previously-set field was removed (which a subset check cannot see).
      const removedField =
        olds !== undefined &&
        JSON.stringify(desiredProperties(olds)) !== JSON.stringify(properties);
      if (
        observed === undefined ||
        !covers(properties, observed.properties) ||
        removedField ||
        tagsDiffer(observed.tags, tags)
      ) {
        yield* maintenance
          .MaintenanceConfigurationsCreateOrUpdate({
            subscriptionId,
            resourceGroupName: resourceGroup,
            resourceName: name,
            location: observed?.location ?? news.location ?? env.location,
            tags,
            properties,
          })
          .pipe(
            // A just-deleted configuration of the same name keeps answering
            // 409 for a while after its GET already reports 404.
            Effect.retry({
              while: (e) => e._tag === "Conflict",
              schedule: Schedule.spaced("10 seconds"),
              times: 12,
            }),
          );
        observed = yield* getConfiguration(subscriptionId, resourceGroup, name);
      }

      return toAttrs(
        resourceGroup,
        name,
        observed ?? {
          location: news.location ?? env.location,
          tags,
          properties,
        },
      );
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        maintenance.DeleteMaintenanceConfiguration({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          resourceName: output.maintenanceConfigurationName,
        }),
      );
      yield* waitUntilGone(
        `maintenance configuration ${output.maintenanceConfigurationName}`,
        getConfiguration(
          subscriptionId,
          output.resourceGroup,
          output.maintenanceConfigurationName,
        ),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
