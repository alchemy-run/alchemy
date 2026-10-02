import * as web from "@distilled.cloud/azure/web";
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
import { lower, nameOf, sameLocation } from "./common.ts";

export interface StaticSiteUserProvidedFunctionAppProps {
  /** Resource group of the static site. Changing it replaces the link. */
  resourceGroup: string;
  /** Name of the static site. Changing it replaces the link. */
  staticSiteName: string;
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
 * Static Web App (`Microsoft.Web/staticSites/userProvidedFunctionApps`) so
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
 *   resourceGroup: group.resourceGroupName,
 *   staticSiteName: site.staticSiteName,
 *   functionAppResourceId: functionApp.siteId,
 *   functionAppRegion: functionApp.location,
 * });
 * ```
 *
 * @resource
 */
export const StaticSiteUserProvidedFunctionApp =
  Resource<StaticSiteUserProvidedFunctionApp>(
    "Azure.Web.StaticSiteUserProvidedFunctionApp",
  );

type ObservedFunctionApp =
  web.GetStaticSiteUserProvidedFunctionAppForStaticSiteResponse;

const getFunctionApp = (
  subscriptionId: string,
  resourceGroupName: string,
  name: string,
  functionAppName: string,
) =>
  orUndefinedIfNotFound(
    web.GetStaticSiteUserProvidedFunctionAppForStaticSite({
      subscriptionId,
      resourceGroupName,
      name,
      functionAppName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  staticSiteName: string,
  functionAppName: string,
  observed: ObservedFunctionApp,
): StaticSiteUserProvidedFunctionApp["Attributes"] => ({
  functionAppName,
  userProvidedFunctionAppId: observed.id ?? "",
  staticSiteName,
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
        lower(news.functionAppResourceId) !==
          lower(output.functionAppResourceId) ||
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
      const functionAppName =
        output?.functionAppName ?? nameOf(olds?.functionAppResourceId);
      if (
        resourceGroup === undefined ||
        staticSiteName === undefined ||
        functionAppName === undefined
      ) {
        return undefined;
      }
      const observed = yield* getFunctionApp(
        subscriptionId,
        resourceGroup,
        staticSiteName,
        functionAppName,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(
        resourceGroup,
        staticSiteName,
        functionAppName,
        observed,
      );
      // Registrations carry no tags; only one this stack recorded is ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Web");
      const { resourceGroup, staticSiteName } = news;
      const functionAppName = nameOf(news.functionAppResourceId) ?? "";
      const get = getFunctionApp(
        subscriptionId,
        resourceGroup,
        staticSiteName,
        functionAppName,
      );

      // Observe.
      const observed = yield* get;

      // Ensure. A registration has nothing mutable (changes replace it).
      if (observed === undefined) {
        yield* web.RegisterStaticSiteUserProvidedFunctionAppWithStaticSite({
          subscriptionId,
          resourceGroupName: resourceGroup,
          name: staticSiteName,
          functionAppName,
          isForced: news.isForced ?? false,
          properties: {
            functionAppResourceId: news.functionAppResourceId,
            functionAppRegion: news.functionAppRegion,
          },
        });
      }
      // The registration is long-running; it is usable once readable.
      const ready = yield* waitForProvisioned(
        `user-provided function app ${functionAppName}`,
        get,
        () => undefined,
        { interval: "5 seconds", times: 60 },
      );
      return toAttrs(resourceGroup, staticSiteName, functionAppName, ready);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        web.DetachStaticSiteUserProvidedFunctionAppFromStaticSite({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          name: output.staticSiteName,
          functionAppName: output.functionAppName,
        }),
      );
      yield* waitUntilGone(
        `user-provided function app ${output.functionAppName}`,
        getFunctionApp(
          subscriptionId,
          output.resourceGroup,
          output.staticSiteName,
          output.functionAppName,
        ),
        { interval: "5 seconds", times: 36 },
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Resources.ResourceGroup",
        "Azure.Web.StaticSite",
        "Azure.Web.FunctionApp",
      ],
    },
  });
