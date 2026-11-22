import * as web from "@distilled.cloud/azure/web";
import * as Layer from "effect/Layer";
import { makeSiteActionBinding, WebRole } from "./BindingHttp.ts";
import { StartWebApp } from "./StartWebApp.ts";

/**
 * Implementation of {@link StartWebApp} over the distilled `web` ARM
 * operation `StartWebApp`. Assigns the custom `AzureWebSiteStartRole` on the
 * app.
 *
 * @layer
 * @provides Azure.Web.StartWebApp
 */
export const StartWebAppHttp = Layer.effect(
  StartWebApp,
  makeSiteActionBinding({
    tag: "Azure.Web.StartWebApp",
    operation: web.StartWebApp,
    grant: WebRole.SiteStart,
  }),
);
