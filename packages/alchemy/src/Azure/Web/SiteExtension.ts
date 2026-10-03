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
import { lower, siteWhere } from "./common.ts";

export interface SiteExtensionProps {
  /** Resource group of the app. Changing it replaces the extension. */
  resourceGroup: string;
  /** Name of the Windows web app or function app. Changing it replaces it. */
  siteName: string;
  /**
   * ID of the extension in the site extension gallery
   * (https://www.siteextensions.net), e.g. `Microsoft.AspNetCore.AzureAppServices.SiteExtension`.
   * Changing it replaces the extension.
   */
  extensionId: string;
}

export interface SiteExtension extends Resource<
  "Azure.Web.SiteExtension",
  SiteExtensionProps,
  {
    /** ID of the extension. */
    extensionId: string;
    /** ARM resource ID of the installed extension. */
    siteExtensionId: string;
    /** Name of the app. */
    siteName: string;
    /** Resource group of the app. */
    resourceGroup: string;
    /** Installed version. */
    version: string | undefined;
    /** Title of the extension. */
    title: string | undefined;
    /** Local install path on the app's file system. */
    localPath: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A site extension installed into a Windows App Service app
 * (`Microsoft.Web/sites/siteextensions`) from the site extension gallery,
 * e.g. the ASP.NET Core logging extension. Installing it restarts the app.
 *
 * @see https://learn.microsoft.com/rest/api/appservice/web-apps/install-site-extension
 *
 * ### Installing an Extension
 * **Example:** ASP.NET Core logging integration
 * ```typescript
 * yield* Azure.Web.SiteExtension("aspnetcore-logging", {
 *   resourceGroup: group.resourceGroupName,
 *   siteName: app.siteName,
 *   extensionId: "Microsoft.AspNetCore.AzureAppServices.SiteExtension",
 * });
 * ```
 *
 * @resource
 */
export const SiteExtension = Resource<SiteExtension>("Azure.Web.SiteExtension");

type ObservedExtension = web.GetWebAppSiteExtensionResponse;

const getExtension = (
  subscriptionId: string,
  resourceGroup: string,
  siteName: string,
  siteExtensionId: string,
) =>
  orUndefinedIfNotFound(
    web.GetWebAppSiteExtension({
      ...siteWhere(subscriptionId, resourceGroup, siteName),
      siteExtensionId,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  siteName: string,
  extensionId: string,
  observed: ObservedExtension,
): SiteExtension["Attributes"] => ({
  extensionId,
  siteExtensionId: observed.id ?? "",
  siteName,
  resourceGroup,
  version: observed.properties?.version,
  title: observed.properties?.title,
  localPath: observed.properties?.local_path,
});

export const SiteExtensionProvider = () =>
  Provider.succeed(SiteExtension, {
    stables: ["extensionId", "siteExtensionId", "siteName", "resourceGroup"],

    // Extensions are removed with their app.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.siteName) !== lower(output.siteName) ||
        lower(news.extensionId) !== lower(output.extensionId)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const siteName = output?.siteName ?? olds?.siteName;
      const extensionId = output?.extensionId ?? olds?.extensionId;
      if (
        resourceGroup === undefined ||
        siteName === undefined ||
        extensionId === undefined
      ) {
        return undefined;
      }
      const observed = yield* getExtension(
        subscriptionId,
        resourceGroup,
        siteName,
        extensionId,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, siteName, extensionId, observed);
      // Extensions carry no tags; only one this stack recorded is ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Web");
      const { resourceGroup, siteName, extensionId } = news;
      const get = getExtension(
        subscriptionId,
        resourceGroup,
        siteName,
        extensionId,
      );

      // Observe.
      const observed = yield* get;

      // Ensure. An extension has nothing mutable; a failed install is retried.
      if (
        observed === undefined ||
        observed.properties?.provisioningState === "Failed"
      ) {
        yield* web.InstallWebAppSiteExtension({
          ...siteWhere(subscriptionId, resourceGroup, siteName),
          siteExtensionId: extensionId,
        });
      }
      const installed = yield* waitForProvisioned(
        `site extension ${extensionId}`,
        get,
        (extension) => extension.properties?.provisioningState,
        { interval: "5 seconds", times: 60 },
      );
      return toAttrs(resourceGroup, siteName, extensionId, installed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        web.DeleteWebAppSiteExtension({
          ...siteWhere(subscriptionId, output.resourceGroup, output.siteName),
          siteExtensionId: output.extensionId,
        }),
      );
      yield* waitUntilGone(
        `site extension ${output.extensionId}`,
        getExtension(
          subscriptionId,
          output.resourceGroup,
          output.siteName,
          output.extensionId,
        ),
        { interval: "5 seconds", times: 24 },
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Resources.ResourceGroup",
        "Azure.Web.WebApp",
        "Azure.Web.FunctionApp",
      ],
    },
  });
