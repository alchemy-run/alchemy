import * as web from "@distilled.cloud/azure/web";
import * as Layer from "effect/Layer";
import { makeSiteActionBinding, WebRole } from "./BindingHttp.ts";
import { SyncWebAppFunctionTriggers } from "./SyncWebAppFunctionTriggers.ts";

/**
 * Implementation of {@link SyncWebAppFunctionTriggers} over the distilled `web` ARM
 * operation `SyncWebAppFunctionTriggers`. Assigns the custom `AzureWebSiteSyncFunctionTriggersRole` on the
 * app.
 *
 * @layer
 * @provides Azure.Web.SyncWebAppFunctionTriggers
 */
export const SyncWebAppFunctionTriggersHttp = Layer.effect(
  SyncWebAppFunctionTriggers,
  makeSiteActionBinding({
    tag: "Azure.Web.SyncWebAppFunctionTriggers",
    operation: web.SyncWebAppFunctionTriggers,
    grant: WebRole.SiteSyncFunctionTriggers,
  }),
);
