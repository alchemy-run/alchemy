import * as web from "@distilled.cloud/azure/web";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { lower, nameOf, sameLocation } from "./common.ts";

export interface StaticSiteUserProvidedFunctionAppProps {
  /** Resource group of the static site. Changing it replaces the link. */
  resourceGroup: string;
  /** Name of the static site. Changing it replaces the link. */
  staticSiteName: string;
  /**
   * Environment (build) the link applies to, e.g. a pull request preview
   * environment. Changing it replaces the link.
   * @default the production environment
   */
  environmentName?: string;
  /**
   * ARM ID of the function app that serves the site's `/api` routes.
   * Changing it replaces the link.
   */
  functionAppResourceId: string;
  /** Location of the function app, e.g. `eastus`. Changing it replaces it. */
  functionAppRegion: string;
  /**
   * Register the function app even if it is already linked to another
   * static site (the other link is removed).
   * @default false
   */
  isForced?: boolean;
}

export interface StaticSiteUserProvidedFunctionApp extends Resource<
  "Azure.Web.StaticSiteUserProvidedFunctionApp",
  StaticSiteUserProvidedFunctionAppProps,
  {
    /** Name of the function app (the name of the link). */
    functionAppName: string;
    /** ARM resource ID of the link. */
    userProvidedFunctionAppId: string;
    /** Name of the static site. */
    staticSiteName: string;
    /** Environment (build), if environment-scoped. */
    environmentName: string | undefined;
    /** Resource group of the static site. */
    resourceGroup: string;
    /** ARM ID of the function app. */
    functionAppResourceId: string;
    /** Location of the function app. */
    functionAppRegion: string;
    /** When the function app was linked (ISO 8601). */
    createdOn: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A "bring your own functions" function app registered with an Azure
 * Static Web App (`Microsoft.Web/staticSites/userProvidedFunctionApps`, or
 * `staticSites/builds/userProvidedFunctionApps` with `environmentName`) so
 * requests to `/api/*` are routed to it. Requires the `Standard` plan; a
 * site has at most one. New sites should prefer
 * `Azure.Web.StaticSiteLinkedBackend`, which also supports container apps and
 * API Management.
 *
 * @see https://learn.microsoft.com/azure/static-web-apps/functions-bring-your-own
 *
 * ### Registering a Function App
 * **Example:** Function app behind `/api`
 * ```typescript
 * yield* Azure.Web.StaticSiteUserProvidedFunctionApp("api", {
 *   staticSiteName: site.staticSiteName,
 *   functionAppResourceId: functionApp.siteId,
 *   functionAppRegion: functionApp.location,
 * });
 * ```
 *
 * @resource
 */
export const StaticSiteUserProvidedFunctionApp = GroupedResource<StaticSiteUserProvidedFunctionApp>(
  "Azure.Web.StaticSiteUserProvidedFunctionApp",
);

type ObservedFunctionApp = web.GetStaticSiteUserProvidedFunctionAppForStaticSiteResponse;

const getFunctionApp = (
  subscriptionId: string,
  resourceGroupName: string,
  name: string,
  environmentName: string | undefined,
  functionAppName: string,
) => {
  const where = { subscriptionId, resourceGroupName, name, functionAppName };
  return orUndefinedIfNotFound(
    environmentName === undefined
      ? web.GetStaticSiteUserProvidedFunctionAppForStaticSite(where)
      : web.GetStaticSiteUserProvidedFunctionAppForStaticSiteBuild({ ...where, environmentName }),
  );
};

const toAttrs = (
  resourceGroup: string,
  staticSiteName: string,
  environmentName: string | undefined,
  functionAppName: string,
  observed: ObservedFunctionApp,
): StaticSiteUserProvidedFunctionApp["Attributes"] => ({
  functionAppName,
  userProvidedFunctionAppId: observed.id ?? "",
  staticSiteName,
  environmentName,
  resourceGroup,
  functionAppResourceId: observed.properties?.functionAppResourceId ?? "",
  functionAppRegion: observed.properties?.functionAppRegion ?? "",
  createdOn: observed.properties?.createdOn,
});

export const StaticSiteUserProvidedFunctionAppProvider = () =>
  Provider.succeed(StaticSiteUserProvidedFunctionApp, {
    stables: [
      "functionAppName",
      "userProvidedFunctionAppId",
      "staticSiteName",
      "environmentName",
      "resourceGroup",
      "functionAppResourceId",
      "functionAppRegion",
    ],

    // Registrations are removed with their static site.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.staticSiteName) !== lower(output.staticSiteName) ||
        news.environmentName !== output.environmentName ||
        lower(news.functionAppResourceId) !== lower(output.functionAppResourceId) ||
        !sameLocation(news.functionAppRegion, output.functionAppRegion)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const staticSiteName = output?.staticSiteName ?? olds?.staticSiteName;
      const functionAppName = output?.functionAppName ?? nameOf(olds?.functionAppResourceId);
      if (
        resourceGroup === undefined ||
        staticSiteName === undefined ||
        functionAppName === undefined
      ) {
        return undefined;
      }
      const environmentName = output?.environmentName ?? olds?.environmentName;
      const observed = yield* getFunctionApp(
        subscriptionId,
        resourceGroup,
        staticSiteName,
        environmentName,
        functionAppName,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(
        resourceGroup,
        staticSiteName,
        environmentName,
        functionAppName,
        observed,
      );
      // Registrations carry no tags; only one this stack recorded is ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Web");
      const { resourceGroup, staticSiteName, environmentName } = news;
      const functionAppName = nameOf(news.functionAppResourceId) ?? "";
      const get = getFunctionApp(
        subscriptionId,
        resourceGroup,
        staticSiteName,
        environmentName,
        functionAppName,
      );

      // Observe.
      const observed = yield* get;

      // Ensure. A registration has nothing mutable (changes replace it).
      if (observed === undefined) {
        const request = {
          subscriptionId,
          resourceGroupName: resourceGroup,
          name: staticSiteName,
          functionAppName,
          isForced: news.isForced ?? false,
          properties: {
            functionAppResourceId: news.functionAppResourceId,
            functionAppRegion: news.functionAppRegion,
          },
        };
        yield* environmentName === undefined
          ? web.RegisterStaticSiteUserProvidedFunctionAppWithStaticSite(request)
          : web.RegisterStaticSiteUserProvidedFunctionAppWithStaticSiteBuild({
              ...request,
              environmentName,
            });
      }
      // The registration is long-running; it is usable once readable.
      const ready = yield* waitForProvisioned(
        `user-provided function app ${functionAppName}`,
        get,
        () => undefined,
        { interval: "5 seconds", times: 60 },
      );
      return toAttrs(resourceGroup, staticSiteName, environmentName, functionAppName, ready);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const where = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        name: output.staticSiteName,
        functionAppName: output.functionAppName,
      };
      yield* ignoreNotFound(
        output.environmentName === undefined
          ? web.DetachStaticSiteUserProvidedFunctionAppFromStaticSite(where)
          : web.DetachStaticSiteUserProvidedFunctionAppFromStaticSiteBuild({
              ...where,
              environmentName: output.environmentName,
            }),
      );
      yield* waitUntilGone(
        `user-provided function app ${output.functionAppName}`,
        getFunctionApp(
          subscriptionId,
          output.resourceGroup,
          output.staticSiteName,
          output.environmentName,
          output.functionAppName,
        ),
        { interval: "5 seconds", times: 36 },
      );
    }),

    nuke: {
      dependsOn: ["Azure.Resources.ResourceGroup", "Azure.Web.StaticSite", "Azure.Web.FunctionApp"],
    },
  });
