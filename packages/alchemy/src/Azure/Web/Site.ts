import * as web from "@distilled.cloud/azure/web";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  requireSinglePage,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import {
  changedKeys,
  lower,
  matchesDesired,
  nameOf,
  sameLocation,
} from "./common.ts";

/**
 * Site configuration (`sites/config/web`): runtime stack, TLS, CORS, health
 * checks, and so on. App settings, connection strings, and storage mounts
 * are managed separately.
 */
export type SiteConfig = Omit<
  web.SiteConfigInput,
  | "appSettings"
  | "connectionStrings"
  | "azureStorageAccounts"
  | "metadata"
  | "publishingUsername"
>;

/** Managed identity of a web app or function app. */
export interface SiteIdentity {
  /** Identity type. */
  type: "SystemAssigned" | "UserAssigned" | "SystemAssigned, UserAssigned";
  /** ARM IDs of user-assigned identities to attach. */
  userAssignedIdentityIds?: string[];
}

/** Operating system of a web app or function app. */
export type SiteOs = "linux" | "windows";

/** Props shared by `Web.WebApp` and `Web.FunctionApp`. */
export interface SiteProps {
  /** Resource group the app is created in. Changing it replaces the app. */
  resourceGroup: string;
  /**
   * Globally unique app name (the `{name}.azurewebsites.net` label): 2-60
   * letters, digits, and hyphens. If omitted, a unique name is generated
   * from the app, stage, and logical ID. Changing it replaces the app.
   */
  name?: string;
  /**
   * Azure location of the app; must match the plan's location. Changing it
   * replaces the app.
   * @default the location of the App Service plan
   */
  location?: string;
  /**
   * ARM resource ID of the App Service plan the app runs on. Moving to a
   * plan in another resource group replaces the app.
   */
  serverFarmId: string;
  /**
   * Operating system; must match the plan's. Changing it replaces the app.
   * @default "linux"
   */
  os?: SiteOs;
  /** Site configuration (runtime stack, TLS, CORS, health check, ...). */
  siteConfig?: SiteConfig;
  /**
   * App settings, exposed to the app as environment variables. The app's
   * settings are replaced with exactly this map.
   */
  appSettings?: Record<string, string>;
  /**
   * Redirect plain HTTP requests to HTTPS.
   * @default true
   */
  httpsOnly?: boolean;
  /**
   * Whether the app serves traffic.
   * @default Azure's default (`true`)
   */
  enabled?: boolean;
  /**
   * Pin each client to one instance with an affinity cookie.
   * @default Azure's default
   */
  clientAffinityEnabled?: boolean;
  /**
   * Whether the public endpoint accepts traffic.
   * @default Azure's default (`Enabled`)
   */
  publicNetworkAccess?: "Enabled" | "Disabled";
  /**
   * ARM ID of a subnet (delegated to `Microsoft.Web/serverFarms`) for
   * regional virtual network integration. Requires Basic or higher.
   */
  virtualNetworkSubnetId?: string;
  /**
   * Identity used to resolve Key Vault references in app settings, e.g.
   * `SystemAssigned` or a user-assigned identity's ARM ID.
   */
  keyVaultReferenceIdentity?: string;
  /**
   * Managed identity of the app. Omit it to remove any identity.
   */
  identity?: SiteIdentity;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

/** Attributes shared by `Web.WebApp` and `Web.FunctionApp`. */
export interface SiteAttributes {
  /** Name of the app. */
  siteName: string;
  /** ARM resource ID of the app; use it as a role-assignment scope. */
  siteId: string;
  /** Resource group that holds the app. */
  resourceGroup: string;
  /** Location of the app. */
  location: string;
  /** Resource kind, e.g. `app,linux` or `functionapp,linux`. */
  kind: string;
  /** Operating system of the app. */
  os: SiteOs;
  /** ARM resource ID of the App Service plan. */
  serverFarmId: string;
  /** Default host name, e.g. `{name}.azurewebsites.net`. */
  defaultHostName: string;
  /** HTTPS URL of the default host name. */
  url: string;
  /** Runtime state, e.g. `Running` or `Stopped`. */
  state: string | undefined;
  /** Outbound IP addresses currently in use. */
  outboundIpAddresses: string[];
  /** Every outbound IP address the app may use. */
  possibleOutboundIpAddresses: string[];
  /** Value for the `asuid.{domain}` TXT record of a custom domain. */
  customDomainVerificationId: string | undefined;
  /** Principal ID of the system-assigned identity, if enabled. */
  principalId: string | undefined;
  /** Tenant of the system-assigned identity, if enabled. */
  tenantId: string | undefined;
  /** User tags (Alchemy ownership tags stripped). */
  tags: Record<string, string>;
}

type ObservedSite = web.GetWebAppResponse;

export interface SiteKind<P extends SiteProps> {
  /** `app` or `functionapp`. */
  readonly kind: "app" | "functionapp";
  /** Max generated-name length. */
  readonly maxNameLength: number;
  /** Platform app settings merged under the user's. */
  readonly platformAppSettings: (props: P) => Record<string, string>;
  /** Extra site properties only a PUT can set (e.g. `functionAppConfig`). */
  readonly putOnlyProperties: (props: P) => web.SitePropertiesInput;
  /** Extra replacement triggers. */
  readonly replaces?: (news: P, olds: P | undefined) => boolean;
  /** Whether a replacement must delete the old app before creating the new. */
  readonly deleteFirst?: (news: P, output: SiteAttributes) => boolean;
}

const splitIps = (value: string | undefined) =>
  value
    ? value
        .split(",")
        .map((ip) => ip.trim())
        .filter((ip) => ip.length > 0)
    : [];

export const siteKindOf = (kind: "app" | "functionapp", os: SiteOs) =>
  os === "linux" ? `${kind},linux` : kind;

const toAttrs = (
  resourceGroup: string,
  name: string,
  site: ObservedSite,
): SiteAttributes => {
  const props = site.properties;
  const host = props?.defaultHostName ?? "";
  return {
    siteName: name,
    siteId: site.id ?? "",
    resourceGroup,
    location: site.location,
    kind: site.kind ?? "",
    os: props?.reserved ? "linux" : "windows",
    serverFarmId: props?.serverFarmId ?? "",
    defaultHostName: host,
    url: host ? `https://${host}` : "",
    state: props?.state,
    outboundIpAddresses: splitIps(props?.outboundIpAddresses),
    possibleOutboundIpAddresses: splitIps(props?.possibleOutboundIpAddresses),
    customDomainVerificationId: props?.customDomainVerificationId,
    principalId: site.identity?.principalId,
    tenantId: site.identity?.tenantId,
    tags: userTags(site.tags),
  };
};

export const getSite = (
  subscriptionId: string,
  resourceGroupName: string,
  name: string,
) =>
  orUndefinedIfNotFound(
    web.GetWebApp({ subscriptionId, resourceGroupName, name }),
  );

/** A site is usable once it reports a settled runtime state. */
const siteState = (site: ObservedSite) => {
  const state = site.properties?.state;
  return state === undefined || state === "Running" || state === "Stopped"
    ? undefined
    : "InProgress";
};

const isKind = (kind: "app" | "functionapp", observed: string | undefined) =>
  (observed ?? "").toLowerCase().includes("functionapp") ===
  (kind === "functionapp");

const toIdentity = (
  identity: SiteIdentity | undefined,
): web.ManagedServiceIdentityInput =>
  identity === undefined
    ? { type: "None" }
    : {
        type: identity.type,
        userAssignedIdentities: identity.userAssignedIdentityIds?.length
          ? Object.fromEntries(
              identity.userAssignedIdentityIds.map((armId) => [armId, {}]),
            )
          : undefined,
      };

const identityMatches = (
  desired: SiteIdentity | undefined,
  observed: web.ManagedServiceIdentity | undefined,
) => {
  const observedType = (observed?.type ?? "None").replaceAll(" ", "");
  const desiredType = (desired?.type ?? "None").replaceAll(" ", "");
  if (observedType.toLowerCase() !== desiredType.toLowerCase()) return false;
  const want = (desired?.userAssignedIdentityIds ?? [])
    .map((armId) => armId.toLowerCase())
    .sort();
  const have = Object.keys(observed?.userAssignedIdentities ?? {})
    .map((armId) => armId.toLowerCase())
    .sort();
  return want.join(",") === have.join(",");
};

const settingsMatch = (
  desired: Record<string, string>,
  observed: Record<string, string | undefined> | undefined,
) => {
  const have = observed ?? {};
  const keys = new Set([...Object.keys(desired), ...Object.keys(have)]);
  for (const key of keys) {
    if (desired[key] !== have[key]) return false;
  }
  return true;
};

/**
 * The shared provider body for `Microsoft.Web/sites` resources (web apps
 * and function apps).
 */
export const makeSiteLifecycle = <P extends SiteProps>(spec: SiteKind<P>) => {
  const createSiteName = (id: string) =>
    createPhysicalName({ id, maxLength: spec.maxNameLength, lowercase: true });

  const planLocation = (subscriptionId: string, serverFarmId: string) =>
    Effect.gen(function* () {
      const group = resourceGroupOf(serverFarmId);
      const name = nameOf(serverFarmId);
      if (group === undefined || name === undefined) return undefined;
      const plan = yield* orUndefinedIfNotFound(
        web.GetAppServicePlan({
          subscriptionId,
          resourceGroupName: group,
          name,
        }),
      );
      return plan?.location;
    });

  return {
    stables: [
      "siteName",
      "siteId",
      "resourceGroup",
      "location",
      "os",
      "defaultHostName",
      "url",
    ] as (keyof SiteAttributes)[],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* web
        .ListWebApps({ subscriptionId })
        .pipe(Effect.flatMap((page) => requireSinglePage("ListWebApps", page)));
      return (page.value ?? []).flatMap((site) => {
        const group = resourceGroupOf(site.id);
        return hasAnyAlchemyTag(site.tags) &&
          isKind(spec.kind, site.kind) &&
          group !== undefined &&
          site.name !== undefined
          ? [toAttrs(group, site.name, site)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({
      news,
      olds,
      output,
    }: {
      news: Input<P>;
      olds: P;
      output: SiteAttributes | undefined;
    }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const resolved = news as P;
      if (
        lower(resolved.resourceGroup) !== lower(output.resourceGroup) ||
        (resolved.name !== undefined &&
          lower(resolved.name) !== lower(output.siteName)) ||
        (resolved.location !== undefined &&
          !sameLocation(resolved.location, output.location)) ||
        (resolved.os ?? "linux") !== output.os ||
        lower(resourceGroupOf(resolved.serverFarmId)) !==
          lower(resourceGroupOf(output.serverFarmId)) ||
        (spec.replaces?.(resolved, olds) ?? false)
      ) {
        return spec.deleteFirst?.(resolved, output)
          ? ({ action: "replace", deleteFirst: true } as const)
          : ({ action: "replace" } as const);
      }
      return undefined;
    }),

    read: Effect.fn(function* ({
      id,
      olds,
      output,
    }: {
      id: string;
      olds: P | undefined;
      output: SiteAttributes | undefined;
    }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.siteName ?? olds?.name ?? (yield* createSiteName(id));
      const observed = yield* getSite(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({
      id,
      news,
      output,
    }: {
      id: string;
      news: P;
      output: SiteAttributes | undefined;
    }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Web");
      const resourceGroup = news.resourceGroup;
      const name = news.name ?? output?.siteName ?? (yield* createSiteName(id));
      const location =
        news.location ??
        output?.location ??
        (yield* planLocation(subscriptionId, news.serverFarmId)) ??
        env.location;
      const os = news.os ?? "linux";
      const kind = siteKindOf(spec.kind, os);
      const tags = yield* desiredTags(id, news.tags);
      const siteConfig: SiteConfig = news.siteConfig ?? {};
      const appSettings = {
        ...spec.platformAppSettings(news),
        ...news.appSettings,
      };
      const siteProps = {
        serverFarmId: news.serverFarmId,
        httpsOnly: news.httpsOnly ?? true,
        enabled: news.enabled,
        clientAffinityEnabled: news.clientAffinityEnabled,
        publicNetworkAccess: news.publicNetworkAccess,
        virtualNetworkSubnetId: news.virtualNetworkSubnetId,
        keyVaultReferenceIdentity: news.keyVaultReferenceIdentity,
      };
      const putOnly = spec.putOnlyProperties(news);
      const where = { subscriptionId, resourceGroupName: resourceGroup, name };
      const label = `${spec.kind === "app" ? "web app" : "function app"} ${name}`;
      const get = getSite(subscriptionId, resourceGroup, name);
      const waitReady = waitForProvisioned(label, get, siteState, {
        interval: "3 seconds",
        times: 60,
      });
      const put = web.WebAppsCreateOrUpdate({
        ...where,
        location,
        kind,
        tags,
        identity: news.identity ? toIdentity(news.identity) : undefined,
        properties: {
          ...siteProps,
          ...putOnly,
          reserved: os === "linux",
          siteConfig: {
            ...siteConfig,
            appSettings: Object.entries(appSettings).map(([key, value]) => ({
              name: key,
              value,
            })),
          },
        },
      });

      // Observe.
      let observed = yield* get;

      // Ensure. Site creation is a long-running operation.
      if (observed === undefined) {
        yield* put;
      }
      observed = yield* waitReady;

      // Sync tags and PUT-only properties (e.g. Flex Consumption runtime).
      // The PATCH body cannot carry them and Microsoft.Web rejects the
      // generic tags API, so either delta re-sends the full PUT.
      if (
        !matchesDesired(putOnly, observed.properties) ||
        tagsDiffer(observed.tags, tags)
      ) {
        yield* put;
        observed = yield* waitReady;
      }

      // Sync site properties and identity against observed state.
      const changed = changedKeys(siteProps, observed.properties);
      const identityChanged = !identityMatches(
        news.identity,
        observed.identity,
      );
      if (Object.keys(changed).length > 0 || identityChanged) {
        yield* web.UpdateWebApp({
          ...where,
          properties: Object.keys(changed).length > 0 ? changed : undefined,
          identity: identityChanged ? toIdentity(news.identity) : undefined,
        });
        observed = yield* waitReady;
      }

      // Sync site configuration (`config/web`): PATCH only the deltas.
      const config = yield* web.GetWebAppConfiguration(where);
      const configChanged = changedKeys(siteConfig, config.properties);
      if (Object.keys(configChanged).length > 0) {
        yield* web.UpdateWebAppConfiguration({
          ...where,
          properties: configChanged,
        });
      }

      // Sync app settings (`config/appsettings`, full replace).
      const settings = yield* web.ListWebAppApplicationSettings(where);
      if (!settingsMatch(appSettings, settings.properties)) {
        yield* web.UpdateWebAppApplicationSettings({
          ...where,
          properties: appSettings,
        });
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }: { output: SiteAttributes }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        web.DeleteWebApp({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          name: output.siteName,
          deleteEmptyServerFarm: false,
        }),
      );
      yield* waitUntilGone(
        `site ${output.siteName}`,
        getSite(subscriptionId, output.resourceGroup, output.siteName),
      );
    }),
  };
};
