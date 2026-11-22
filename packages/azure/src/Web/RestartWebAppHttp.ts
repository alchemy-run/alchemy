import * as web from "@distilled.cloud/azure/web";
import * as Layer from "effect/Layer";
import { makeSiteActionBinding, WebRole } from "./BindingHttp.ts";
import { RestartWebApp } from "./RestartWebApp.ts";

/**
 * Implementation of {@link RestartWebApp} over the distilled `web` ARM
 * operation `RestartWebApp`. Assigns the custom `AzureWebSiteRestartRole` on the
 * app.
 *
 * @layer
 * @provides Azure.Web.RestartWebApp
 */
export const RestartWebAppHttp = Layer.effect(
  RestartWebApp,
  makeSiteActionBinding({
    tag: "Azure.Web.RestartWebApp",
    operation: web.RestartWebApp,
    grant: WebRole.SiteRestart,
  }),
);
