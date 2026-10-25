import * as web from "@distilled.cloud/azure/web";
import * as Layer from "effect/Layer";
import { makeSiteActionBinding, WebRole } from "./BindingHttp.ts";
import { StopWebApp } from "./StopWebApp.ts";

/**
 * Implementation of {@link StopWebApp} over the distilled `web` ARM
 * operation `StopWebApp`. Assigns the custom `AzureWebSiteStopRole` on the
 * app.
 *
 * @layer
 * @provides Azure.Web.StopWebApp
 */
export const StopWebAppHttp = Layer.effect(
  StopWebApp,
  makeSiteActionBinding({
    tag: "Azure.Web.StopWebApp",
    operation: web.StopWebApp,
    grant: WebRole.SiteStop,
  }),
);
