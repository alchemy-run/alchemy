import * as appconfiguration from "@distilled.cloud/azure/appconfiguration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
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
import type { Providers } from "../Providers.ts";

export type ConfigurationStoreSku =
  | "Free"
  | "Developer"
  | "Standard"
  | "Premium";

/** SKU order: in-place changes may only move up this list. */
const SKU_RANK: Record<string, number> = {
  free: 0,
  developer: 1,
  standard: 2,
  premium: 3,
};

export interface ConfigurationStoreDataPlaneProxy {
  /**
   * How ARM authenticates data-plane requests it proxies (e.g. key-value
   * operations through ARM). `Pass-through` is required when local auth is
   * disabled.
   */
  authenticationMode?: "Local" | "Pass-through";
  /** Whether requests through an ARM private link are allowed. */
  privateLinkDelegation?: "Enabled" | "Disabled";
}

export interface ConfigurationStoreProps {
  /** Resource group the store is created in. Changing it replaces the store. */
  resourceGroup: string;
  /**
   * Globally unique store name (`<name>.azconfig.io`): 5-50 letters, digits,
   * and hyphens. If omitted, a unique name is generated from the app, stage,
   * and logical ID. Changing it replaces the store.
   */
  name?: string;
  /**
   * Azure location of the store. Changing it replaces the store.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Pricing tier. Upgrades (e.g. `Free` → `Standard`) apply in place; a
   * downgrade replaces the store. A subscription may hold only one `Free`
   * store per region.
   * @default "Free"
   */
  sku?: ConfigurationStoreSku;
  /**
   * Disable access keys so only Microsoft Entra ID can authenticate.
   * @default false
   */
  disableLocalAuth?: boolean;
  /** Whether the store accepts traffic from public networks. */
  publicNetworkAccess?: "Enabled" | "Disabled";
  /**
   * Days a deleted store is kept in the soft-deleted state (1-7). Only
   * applies to `Standard` and `Premium`; changing it replaces the store.
   */
  softDeleteRetentionInDays?: number;
  /**
   * Prevent soft-deleted stores from being purged. Can be enabled but never
   * disabled. With purge protection on, a destroyed store keeps its name
   * reserved until the retention period ends.
   * @default false
   */
  enablePurgeProtection?: boolean;
  /** Seconds to retain key-value revisions. */
  defaultKeyValueRevisionRetentionPeriodInSeconds?: number;
  /** ARM data-plane proxy settings. */
  dataPlaneProxy?: ConfigurationStoreDataPlaneProxy;
  /** User tags. Alchemy ownership tags are merged in. */
  tags?: Record<string, string>;
}

export interface ConfigurationStore extends Resource<
  "Azure.AppConfiguration.ConfigurationStore",
  ConfigurationStoreProps,
  {
    /** Name of the store. */
    configurationStoreName: string;
    /** ARM resource ID of the store; use it as a role-assignment scope. */
    configurationStoreId: string;
    /** Resource group that holds the store. */
    resourceGroup: string;
    /** Location of the store. */
    location: string;
    /** Pricing tier. */
    sku: string;
    /** Data-plane endpoint, e.g. `https://<name>.azconfig.io`. */
    endpoint: string;
    /** Whether access keys are disabled. */
    disableLocalAuth: boolean;
    /** Read-write connection string (undefined when local auth is disabled). */
    primaryConnectionString: Redacted.Redacted<string> | undefined;
    /** Read-only connection string (undefined when local auth is disabled). */
    primaryReadOnlyConnectionString: Redacted.Redacted<string> | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure App Configuration store — a managed service for application
 * settings and feature flags.
 *
 * Destroying a `Standard` or `Premium` store soft-deletes it; Alchemy then
 * purges it (unless purge protection is on) so the name can be reused. A
 * store recreated under the name of a soft-deleted one is recovered.
 *
 * @see https://learn.microsoft.com/azure/azure-app-configuration/overview
 *
 * ### Creating a Store
 * **Example:** Free store
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("app");
 * const store = yield* Azure.AppConfiguration.ConfigurationStore("config", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * ```
 *
 * **Example:** Standard store that only accepts Entra ID
 * ```typescript
 * const store = yield* Azure.AppConfiguration.ConfigurationStore("config", {
 *   resourceGroup: group.resourceGroupName,
 *   sku: "Standard",
 *   disableLocalAuth: true,
 *   dataPlaneProxy: { authenticationMode: "Pass-through" },
 * });
 * ```
 *
 * @resource
 */
export const ConfigurationStore = Resource<ConfigurationStore>(
  "Azure.AppConfiguration.ConfigurationStore",
);

type ObservedStore = appconfiguration.GetConfigurationStoreResponse;

const createStoreName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({
    id,
    maxLength: 50,
    lowercase: true,
  });
  return name
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
});

export const getConfigurationStore = (
  subscriptionId: string,
  resourceGroupName: string,
  configStoreName: string,
) =>
  orUndefinedIfNotFound(
    appconfiguration.GetConfigurationStore({
      subscriptionId,
      resourceGroupName,
      configStoreName,
    }),
  );

const getDeletedStore = (
  subscriptionId: string,
  location: string,
  configStoreName: string,
) =>
  orUndefinedIfNotFound(
    appconfiguration.GetConfigurationStoreDeleted({
      subscriptionId,
      location,
      configStoreName,
    }),
  );

const redact = (value: string | Redacted.Redacted<string> | undefined) =>
  value === undefined
    ? undefined
    : Redacted.isRedacted(value)
      ? value
      : Redacted.make(value);

/** Primary read-write and read-only connection strings of the store. */
const listConnectionStrings = (
  subscriptionId: string,
  resourceGroupName: string,
  configStoreName: string,
  disableLocalAuth: boolean,
) =>
  disableLocalAuth
    ? Effect.succeed({ readWrite: undefined, readOnly: undefined })
    : appconfiguration
        .ListConfigurationStoreKeys({
          subscriptionId,
          resourceGroupName,
          configStoreName,
        })
        .pipe(
          Effect.map((page) => {
            const keys = page.value ?? [];
            const readWrite = keys.find((k) => k.readOnly === false);
            const readOnly = keys.find((k) => k.readOnly === true);
            return {
              readWrite: redact(readWrite?.connectionString),
              readOnly: redact(readOnly?.connectionString),
            };
          }),
        );

const toAttrs = (
  resourceGroup: string,
  name: string,
  store: ObservedStore | appconfiguration.ConfigurationStore,
  connection: {
    readWrite: Redacted.Redacted<string> | undefined;
    readOnly: Redacted.Redacted<string> | undefined;
  },
): ConfigurationStore["Attributes"] => ({
  configurationStoreName: name,
  configurationStoreId: store.id ?? "",
  resourceGroup,
  location: store.location,
  sku: store.sku?.name ?? "",
  endpoint: store.properties?.endpoint ?? `https://${name}.azconfig.io`,
  disableLocalAuth: store.properties?.disableLocalAuth ?? false,
  primaryConnectionString: connection.readWrite,
  primaryReadOnlyConnectionString: connection.readOnly,
  tags: userTags(store.tags),
});

const lower = (value: string | undefined) => value?.toLowerCase();
const normLocation = (value: string | undefined) =>
  value?.toLowerCase().replace(/\s/g, "");

const NO_CONNECTION = { readWrite: undefined, readOnly: undefined };

export const ConfigurationStoreProvider = () =>
  Provider.succeed(ConfigurationStore, {
    stables: [
      "configurationStoreName",
      "configurationStoreId",
      "resourceGroup",
      "location",
      "endpoint",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* appconfiguration
        .ListConfigurationStores({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListConfigurationStores", page),
          ),
        );
      return (page.value ?? []).flatMap((store) => {
        const group = resourceGroupOf(store.id);
        return hasAnyAlchemyTag(store.tags) &&
          group !== undefined &&
          store.name !== undefined
          ? [toAttrs(group, store.name, store, NO_CONNECTION)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const newRank = SKU_RANK[lower(news.sku ?? "Free") ?? "free"] ?? 0;
      const oldRank = SKU_RANK[lower(output.sku) ?? "free"] ?? 0;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (news.name !== undefined &&
          news.name !== output.configurationStoreName) ||
        (news.location !== undefined &&
          normLocation(news.location) !== normLocation(output.location)) ||
        newRank < oldRank ||
        (olds !== undefined &&
          news.softDeleteRetentionInDays !== olds.softDeleteRetentionInDays)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.configurationStoreName ??
        olds?.name ??
        (yield* createStoreName(id));
      const observed = yield* getConfigurationStore(
        subscriptionId,
        resourceGroup,
        name,
      );
      if (observed === undefined) return undefined;
      if (!(yield* isOwned(id, observed.tags))) {
        return Unowned(toAttrs(resourceGroup, name, observed, NO_CONNECTION));
      }
      const connection = yield* listConnectionStrings(
        subscriptionId,
        resourceGroup,
        name,
        observed.properties?.disableLocalAuth ?? false,
      );
      return toAttrs(resourceGroup, name, observed, connection);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.AppConfiguration");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ??
        output?.configurationStoreName ??
        (yield* createStoreName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const sku = news.sku ?? "Free";
      const desired = {
        disableLocalAuth: news.disableLocalAuth ?? false,
        publicNetworkAccess: news.publicNetworkAccess,
        enablePurgeProtection: news.enablePurgeProtection,
        defaultKeyValueRevisionRetentionPeriodInSeconds:
          news.defaultKeyValueRevisionRetentionPeriodInSeconds,
      };
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        configStoreName: name,
      };
      const label = `app configuration store ${name}`;
      const get = getConfigurationStore(subscriptionId, resourceGroup, name);
      const waitReady = waitForProvisioned(
        label,
        get,
        (store) => store.properties?.provisioningState,
        { interval: "3 seconds", times: 60 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure. A soft-deleted store under this name blocks a fresh create;
      // recover it and let the sync steps converge its settings.
      if (observed === undefined) {
        const deleted = yield* getDeletedStore(subscriptionId, location, name);
        yield* appconfiguration.CreateConfigurationStore({
          ...where,
          location,
          sku: { name: sku },
          tags,
          properties: {
            ...desired,
            softDeleteRetentionInDays: news.softDeleteRetentionInDays,
            dataPlaneProxy: news.dataPlaneProxy,
            createMode: deleted !== undefined ? "Recover" : undefined,
          },
        });
      }
      observed = yield* waitReady;

      // Sync mutable settings, SKU, and tags against the observed store.
      const props = observed.properties ?? {};
      const changed: appconfiguration.ConfigurationStorePropertiesUpdateParameters =
        {};
      for (const key of Object.keys(desired) as (keyof typeof desired)[]) {
        const value = desired[key];
        if (value !== undefined && props[key] !== value) {
          Object.assign(changed, { [key]: value });
        }
      }
      const proxy = news.dataPlaneProxy;
      if (
        proxy !== undefined &&
        ((proxy.authenticationMode !== undefined &&
          proxy.authenticationMode !==
            props.dataPlaneProxy?.authenticationMode) ||
          (proxy.privateLinkDelegation !== undefined &&
            proxy.privateLinkDelegation !==
              props.dataPlaneProxy?.privateLinkDelegation))
      ) {
        changed.dataPlaneProxy = proxy;
      }
      const skuChanged = lower(observed.sku?.name) !== lower(sku);
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (Object.keys(changed).length > 0 || skuChanged || tagsChanged) {
        yield* appconfiguration.UpdateConfigurationStore({
          ...where,
          sku: skuChanged ? { name: sku } : undefined,
          tags: tagsChanged ? tags : undefined,
          properties: Object.keys(changed).length > 0 ? changed : undefined,
        });
        observed = yield* waitReady;
      }

      const connection = yield* listConnectionStrings(
        subscriptionId,
        resourceGroup,
        name,
        observed.properties?.disableLocalAuth ?? false,
      );
      return toAttrs(resourceGroup, name, observed, connection);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const name = output.configurationStoreName;
      yield* ignoreNotFound(
        appconfiguration.DeleteConfigurationStore({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          configStoreName: name,
        }),
      );
      yield* waitUntilGone(
        `app configuration store ${name}`,
        getConfigurationStore(subscriptionId, output.resourceGroup, name),
      );
      // Standard/Premium stores are soft-deleted; purge so the name is free.
      const deleted = yield* getDeletedStore(
        subscriptionId,
        output.location,
        name,
      );
      if (
        deleted !== undefined &&
        deleted.properties?.purgeProtectionEnabled !== true
      ) {
        yield* ignoreNotFound(
          appconfiguration.PurgeConfigurationStoreDeleted({
            subscriptionId,
            location: output.location,
            configStoreName: name,
          }),
        );
        yield* waitUntilGone(
          `soft-deleted app configuration store ${name}`,
          getDeletedStore(subscriptionId, output.location, name),
          { interval: "5 seconds", times: 36 },
        );
      }
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
