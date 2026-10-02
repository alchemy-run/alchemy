import * as web from "@distilled.cloud/azure/web";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { changedKeys, lower, siteWhere } from "./common.ts";
import { getSite, type SiteConfig, type SiteIdentity } from "./Site.ts";

export interface WebAppSlotProps {
  /** Resource group of the parent app. Changing it replaces the slot. */
  resourceGroup: string;
  /** Name of the parent web app or function app. Changing it replaces the slot. */
  siteName: string;
  /**
   * Name of the slot, e.g. `staging`; the slot is served at
   * `{siteName}-{name}.azurewebsites.net`. If omitted, a unique name is
   * generated from the app, stage, and logical ID. Changing it replaces the
   * slot.
   */
  name?: string;
  /**
   * ARM ID of the App Service plan the slot runs on.
   * @default the parent app's plan
   */
  serverFarmId?: string;
  /** Site configuration of the slot (runtime stack, TLS, CORS, ...). */
  siteConfig?: SiteConfig;
  /**
   * App settings of the slot. The slot's settings are replaced with
   * exactly this map.
   */
  appSettings?: Record<string, string>;
  /**
   * Redirect plain HTTP requests to HTTPS.
   * @default true
   */
  httpsOnly?: boolean;
  /**
   * Whether the slot serves traffic.
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
   * regional virtual network integration.
   */
  virtualNetworkSubnetId?: string;
  /** Managed identity of the slot. Omit it to remove any identity. */
  identity?: SiteIdentity;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface WebAppSlot extends Resource<
  "Azure.Web.WebAppSlot",
  WebAppSlotProps,
  {
    /** Name of the slot. */
    slotName: string;
    /** Name of the parent app. */
    siteName: string;
    /** ARM resource ID of the slot. */
    slotId: string;
    /** Resource group of the parent app. */
    resourceGroup: string;
    /** Location of the slot (the parent app's location). */
    location: string;
    /** Resource kind, e.g. `app,linux`. */
    kind: string;
    /** ARM ID of the App Service plan. */
    serverFarmId: string;
    /** Default host name, e.g. `{site}-{slot}.azurewebsites.net`. */
    defaultHostName: string;
    /** HTTPS URL of the default host name. */
    url: string;
    /** Runtime state, e.g. `Running`. */
    state: string | undefined;
    /** Principal ID of the system-assigned identity, if enabled. */
    principalId: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A deployment slot of an App Service app (`Microsoft.Web/sites/slots`): a
 * live copy of the app with its own host name, configuration, and app
 * settings, used for staged deployments and swaps.
 *
 * Slots need a Standard or higher plan. The slot inherits the parent app's
 * kind and location.
 *
 * @see https://learn.microsoft.com/azure/app-service/deploy-staging-slots
 *
 * ### Creating a Slot
 * **Example:** Staging slot with its own settings
 * ```typescript
 * const staging = yield* Azure.Web.WebAppSlot("staging", {
 *   resourceGroup: group.resourceGroupName,
 *   siteName: app.siteName,
 *   name: "staging",
 *   siteConfig: { linuxFxVersion: "NODE|20-lts" },
 *   appSettings: { ENVIRONMENT: "staging" },
 * });
 * // staging.url -> https://{app}-staging.azurewebsites.net
 * ```
 *
 * @resource
 */
export const WebAppSlot = Resource<WebAppSlot>("Azure.Web.WebAppSlot");

const createSlotName = (id: string) =>
  createPhysicalName({ id, maxLength: 20, lowercase: true });

type ObservedSlot = web.GetWebAppSlotResponse;

const getSlot = (
  subscriptionId: string,
  resourceGroup: string,
  siteName: string,
  slot: string,
) =>
  orUndefinedIfNotFound(
    web.GetWebAppSlot({
      ...siteWhere(subscriptionId, resourceGroup, siteName),
      slot,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  siteName: string,
  slotName: string,
  observed: ObservedSlot,
) => {
  const host = observed.properties?.defaultHostName ?? "";
  return {
    slotName,
    siteName,
    slotId: observed.id ?? "",
    resourceGroup,
    location: observed.location,
    kind: observed.kind ?? "",
    serverFarmId: observed.properties?.serverFarmId ?? "",
    defaultHostName: host,
    url: host ? `https://${host}` : "",
    state: observed.properties?.state,
    principalId: observed.identity?.principalId,
    tags: userTags(observed.tags),
  };
};

/** A slot is usable once it reports a settled runtime state. */
const slotState = (observed: ObservedSlot) => {
  const state = observed.properties?.state;
  return state === undefined || state === "Running" || state === "Stopped"
    ? undefined
    : "InProgress";
};

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
  const norm = (type: string | undefined) =>
    (type ?? "None").replaceAll(" ", "").toLowerCase();
  if (norm(observed?.type) !== norm(desired?.type)) return false;
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

export const WebAppSlotProvider = () =>
  Provider.succeed(WebAppSlot, {
    stables: [
      "slotName",
      "siteName",
      "slotId",
      "resourceGroup",
      "location",
      "defaultHostName",
      "url",
    ],

    // Slots are removed with their app.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.siteName) !== lower(output.siteName) ||
        (news.name !== undefined && lower(news.name) !== lower(output.slotName))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const siteName = output?.siteName ?? olds?.siteName;
      if (!resourceGroup || !siteName) return undefined;
      const slotName =
        output?.slotName ?? olds?.name ?? (yield* createSlotName(id));
      const observed = yield* getSlot(
        subscriptionId,
        resourceGroup,
        siteName,
        slotName,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, siteName, slotName, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Web");
      const { resourceGroup, siteName } = news;
      const slotName =
        news.name ?? output?.slotName ?? (yield* createSlotName(id));
      const where = {
        ...siteWhere(subscriptionId, resourceGroup, siteName),
        slot: slotName,
      };
      const tags = yield* desiredTags(id, news.tags);
      const siteConfig: SiteConfig = news.siteConfig ?? {};
      const appSettings = news.appSettings ?? {};
      const label = `slot ${siteName}/${slotName}`;
      const get = getSlot(subscriptionId, resourceGroup, siteName, slotName);
      const waitReady = waitForProvisioned(label, get, slotState, {
        interval: "3 seconds",
        times: 60,
      });

      // Observe.
      let observed = yield* get;

      // The slot inherits the parent app's location, kind, and plan.
      const parent = yield* getSite(subscriptionId, resourceGroup, siteName);
      const location =
        observed?.location ??
        parent?.location ??
        output?.location ??
        env.location;
      const serverFarmId =
        news.serverFarmId ?? parent?.properties?.serverFarmId;
      const siteProps = {
        serverFarmId,
        httpsOnly: news.httpsOnly ?? true,
        enabled: news.enabled,
        clientAffinityEnabled: news.clientAffinityEnabled,
        publicNetworkAccess: news.publicNetworkAccess,
        virtualNetworkSubnetId: news.virtualNetworkSubnetId,
      };
      const put = web.WebAppsCreateOrUpdateSlot({
        ...where,
        location,
        kind: observed?.kind ?? parent?.kind,
        tags,
        identity: news.identity ? toIdentity(news.identity) : undefined,
        properties: {
          ...siteProps,
          reserved: parent?.properties?.reserved,
          siteConfig: {
            ...siteConfig,
            appSettings: Object.entries(appSettings).map(([name, value]) => ({
              name,
              value,
            })),
          },
        },
      });

      // Ensure. Slot creation is a long-running operation.
      if (observed === undefined) {
        yield* put;
      }
      observed = yield* waitReady;

      // Sync tags. The PATCH body cannot carry tags, so re-send the PUT.
      if (tagsDiffer(observed.tags, tags)) {
        yield* put;
        observed = yield* waitReady;
      }

      // Sync slot properties and identity against observed state.
      const changed = changedKeys(siteProps, observed.properties);
      const identityChanged = !identityMatches(
        news.identity,
        observed.identity,
      );
      if (Object.keys(changed).length > 0 || identityChanged) {
        yield* web.UpdateWebAppSlot({
          ...where,
          properties: Object.keys(changed).length > 0 ? changed : undefined,
          identity: identityChanged ? toIdentity(news.identity) : undefined,
        });
        observed = yield* waitReady;
      }

      // Sync slot configuration (`config/web`): PATCH only the deltas.
      const config = yield* web.GetWebAppConfigurationSlot(where);
      const configChanged = changedKeys(siteConfig, config.properties);
      if (Object.keys(configChanged).length > 0) {
        yield* web.UpdateWebAppConfigurationSlot({
          ...where,
          properties: configChanged,
        });
      }

      // Sync app settings (`config/appsettings`, full replace).
      const settings = yield* web.ListWebAppApplicationSettingsSlot(where);
      if (!settingsMatch(appSettings, settings.properties)) {
        yield* web.UpdateWebAppApplicationSettingsSlot({
          ...where,
          properties: appSettings,
        });
      }

      return toAttrs(resourceGroup, siteName, slotName, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        web.DeleteWebAppSlot({
          ...siteWhere(subscriptionId, output.resourceGroup, output.siteName),
          slot: output.slotName,
          deleteEmptyServerFarm: false,
        }),
      );
      yield* waitUntilGone(
        `slot ${output.siteName}/${output.slotName}`,
        getSlot(
          subscriptionId,
          output.resourceGroup,
          output.siteName,
          output.slotName,
        ),
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
