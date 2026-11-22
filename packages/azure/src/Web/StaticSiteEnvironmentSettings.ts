import * as web from "@distilled.cloud/azure/web";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { ensureRegistered, ignoreNotFound, orUndefinedIfNotFound } from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { lower, settingsMatch } from "./common.ts";

export interface StaticSiteEnvironmentSettingsProps {
  /** Resource group of the static site. Changing it replaces the settings. */
  resourceGroup: string;
  /** Name of the static site. Changing it replaces the settings. */
  staticSiteName: string;
  /**
   * Name of the environment (build), e.g. a pull request number, or
   * `default` for production. Changing it replaces the settings.
   */
  environmentName: string;
  /**
   * App settings of the environment. The environment's settings are
   * replaced with exactly this map.
   * @default {}
   */
  appSettings?: Record<string, string>;
  /**
   * App settings of the environment's managed functions, replaced with
   * exactly this map. Azure accepts them only once the environment has
   * deployed functions ("A function must first be deployed to use this
   * method").
   * @default not managed
   */
  functionAppSettings?: Record<string, string>;
}

export interface StaticSiteEnvironmentSettings extends Resource<
  "Azure.Web.StaticSiteEnvironmentSettings",
  StaticSiteEnvironmentSettingsProps,
  {
    /** Name of the static site. */
    staticSiteName: string;
    /** Name of the environment. */
    environmentName: string;
    /** Resource group of the static site. */
    resourceGroup: string;
    /** Names of the environment's app settings. */
    appSettingNames: string[];
    /** Names of the environment's managed-function app settings. */
    functionAppSettingNames: string[];
  },
  never,
  Providers
> {}

/**
 * App settings of one environment (build) of a Static Web App
 * (`Microsoft.Web/staticSites/builds/config/appsettings` and
 * `/functionappsettings`). Production settings belong on
 * `Azure.Web.StaticSite`'s `appSettings`; use this resource for a named
 * environment that a deployment created, e.g. a pull request preview.
 * Deleting the resource clears the maps it manages.
 *
 * :::caution
 * Changing `resourceGroup`, `staticSiteName`, or `environmentName`
 * replaces the settings.
 * :::
 *
 * @see https://learn.microsoft.com/azure/static-web-apps/application-settings
 *
 * ### Configuring an Environment
 * **Example:** Settings of a preview environment
 * ```typescript
 * yield* Azure.Web.StaticSiteEnvironmentSettings("preview-settings", {
 *   staticSiteName: site.staticSiteName,
 *   environmentName: "42",
 *   appSettings: { API_URL: "https://preview.example.com" },
 * });
 * ```
 *
 * @resource
 */
export const StaticSiteEnvironmentSettings = GroupedResource<StaticSiteEnvironmentSettings>(
  "Azure.Web.StaticSiteEnvironmentSettings",
);

const buildWhere = (
  subscriptionId: string,
  resourceGroup: string,
  staticSiteName: string,
  environmentName: string,
) => ({
  subscriptionId,
  resourceGroupName: resourceGroup,
  name: staticSiteName,
  environmentName,
});

type Where = ReturnType<typeof buildWhere>;

/**
 * Observe the app settings, and the function app settings when they are
 * managed; `undefined` when the environment is gone.
 */
const observe = (where: Where, withFunctions: boolean) =>
  Effect.gen(function* () {
    const app = yield* orUndefinedIfNotFound(web.ListStaticSiteStaticSiteBuildAppSettings(where));
    if (app === undefined) return undefined;
    if (!withFunctions) return { appSettings: app.properties ?? {}, functionAppSettings: {} };
    const fn = yield* orUndefinedIfNotFound(
      web.ListStaticSiteStaticSiteBuildFunctionAppSettings(where),
    );
    if (fn === undefined) return undefined;
    return { appSettings: app.properties ?? {}, functionAppSettings: fn.properties ?? {} };
  });

const toAttrs = (
  where: Where,
  appSettings: Record<string, unknown>,
  functionAppSettings: Record<string, unknown>,
): StaticSiteEnvironmentSettings["Attributes"] => ({
  staticSiteName: where.name,
  environmentName: where.environmentName,
  resourceGroup: where.resourceGroupName,
  appSettingNames: Object.keys(appSettings).sort(),
  functionAppSettingNames: Object.keys(functionAppSettings).sort(),
});

export const StaticSiteEnvironmentSettingsProvider = () =>
  Provider.succeed(StaticSiteEnvironmentSettings, {
    stables: ["staticSiteName", "environmentName", "resourceGroup"],

    // The settings exist exactly as long as their environment.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.staticSiteName) !== lower(output.staticSiteName) ||
        news.environmentName !== output.environmentName
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const staticSiteName = output?.staticSiteName ?? olds?.staticSiteName;
      const environmentName = output?.environmentName ?? olds?.environmentName;
      if (
        resourceGroup === undefined ||
        staticSiteName === undefined ||
        environmentName === undefined
      ) {
        return undefined;
      }
      const where = buildWhere(subscriptionId, resourceGroup, staticSiteName, environmentName);
      const withFunctions =
        (output?.functionAppSettingNames.length ?? 0) > 0 ||
        olds?.functionAppSettings !== undefined;
      const observed = yield* observe(where, withFunctions);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(where, observed.appSettings, observed.functionAppSettings);
      if (output !== undefined) return attrs;
      // Empty maps are the singleton's absent state; settings without tags
      // may belong to someone else.
      return attrs.appSettingNames.length === 0 && attrs.functionAppSettingNames.length === 0
        ? undefined
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Web");
      const where = buildWhere(
        subscriptionId,
        news.resourceGroup,
        news.staticSiteName,
        news.environmentName,
      );
      const appSettings = news.appSettings ?? {};
      const functionAppSettings = news.functionAppSettings;

      // Observe.
      const observed = yield* observe(where, functionAppSettings !== undefined);

      // Sync each map (full replace, synchronous PUT) only on drift.
      if (!settingsMatch(appSettings, observed?.appSettings)) {
        yield* web.StaticSitesCreateOrUpdateStaticSiteBuildAppSettings({
          ...where,
          properties: appSettings,
        });
      }
      if (
        functionAppSettings !== undefined &&
        !settingsMatch(functionAppSettings, observed?.functionAppSettings)
      ) {
        yield* web.StaticSitesCreateOrUpdateStaticSiteBuildFunctionAppSettings({
          ...where,
          properties: functionAppSettings,
        });
      }
      return toAttrs(where, appSettings, functionAppSettings ?? {});
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const where = buildWhere(
        subscriptionId,
        output.resourceGroup,
        output.staticSiteName,
        output.environmentName,
      );
      // The settings cannot be removed: clear the managed maps.
      const observed = yield* observe(where, output.functionAppSettingNames.length > 0);
      if (observed === undefined) return;
      if (Object.keys(observed.appSettings).length > 0) {
        yield* ignoreNotFound(
          web.StaticSitesCreateOrUpdateStaticSiteBuildAppSettings({ ...where, properties: {} }),
        );
      }
      if (Object.keys(observed.functionAppSettings).length > 0) {
        yield* ignoreNotFound(
          web.StaticSitesCreateOrUpdateStaticSiteBuildFunctionAppSettings({
            ...where,
            properties: {},
          }),
        );
      }
    }),

    nuke: {
      dependsOn: ["Azure.Resources.ResourceGroup", "Azure.Web.StaticSite"],
    },
  });
