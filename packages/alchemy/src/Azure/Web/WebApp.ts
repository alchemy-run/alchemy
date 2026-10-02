import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import {
  makeSiteLifecycle,
  type SiteAttributes,
  type SiteProps,
} from "./Site.ts";

export interface WebAppProps extends SiteProps {}

export interface WebApp extends Resource<
  "Azure.Web.WebApp",
  WebAppProps,
  SiteAttributes,
  never,
  Providers
> {}

/**
 * An Azure App Service web app (`Microsoft.Web/sites`, kind `app`) running
 * on an App Service plan.
 *
 * Alchemy syncs the site properties, the site configuration
 * (`config/web`), the app settings, the managed identity, and tags against
 * the live app on every deploy. HTTPS-only is on by default.
 *
 * @see https://learn.microsoft.com/azure/app-service/overview
 *
 * ### Creating a Web App
 * **Example:** Node.js app on a free Linux plan
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("app");
 * const plan = yield* Azure.Web.AppServicePlan("plan", {
 *   resourceGroup: group.resourceGroupName,
 *   sku: "F1",
 * });
 * const app = yield* Azure.Web.WebApp("site", {
 *   resourceGroup: group.resourceGroupName,
 *   serverFarmId: plan.appServicePlanId,
 *   siteConfig: { linuxFxVersion: "NODE|20-lts", alwaysOn: false },
 * });
 * ```
 *
 * ### Configuration
 * **Example:** App settings and a health check
 * ```typescript
 * const app = yield* Azure.Web.WebApp("site", {
 *   resourceGroup: group.resourceGroupName,
 *   serverFarmId: plan.appServicePlanId,
 *   siteConfig: {
 *     linuxFxVersion: "NODE|20-lts",
 *     healthCheckPath: "/healthz",
 *     minTlsVersion: "1.2",
 *     ftpsState: "Disabled",
 *   },
 *   appSettings: { NODE_ENV: "production" },
 * });
 * ```
 *
 * ### Managed Identity
 * **Example:** System-assigned identity
 * ```typescript
 * const app = yield* Azure.Web.WebApp("site", {
 *   resourceGroup: group.resourceGroupName,
 *   serverFarmId: plan.appServicePlanId,
 *   identity: { type: "SystemAssigned" },
 * });
 * // app.principalId can be granted roles with Azure.Authorization.RoleAssignment
 * ```
 *
 * @resource
 */
export const WebApp = Resource<WebApp>("Azure.Web.WebApp");

const lifecycle = makeSiteLifecycle<WebAppProps>({
  kind: "app",
  maxNameLength: 60,
  platformAppSettings: () => ({}),
  putOnlyProperties: () => ({}),
});

export const WebAppProvider = () =>
  Provider.succeed(WebApp, {
    ...lifecycle,
    nuke: {
      dependsOn: ["Azure.Resources.ResourceGroup", "Azure.Web.AppServicePlan"],
    },
  });
