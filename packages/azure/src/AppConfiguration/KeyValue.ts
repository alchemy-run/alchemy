import * as appconfiguration from "@distilled.cloud/azure/appconfiguration";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import {
  desiredTags,
  ensureRegistered,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  tagsDiffer,
  userTags,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";

export interface KeyValueProps {
  /**
   * Resource group of the configuration store. Changing it replaces the key-value.
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
  resourceGroup: string;
  /** Configuration store that holds the key-value. Changing it replaces the key-value. */
  configurationStore: string;
  /**
   * The key, e.g. `App:Settings:Color`. Any characters except `%` are
   * allowed. Changing it replaces the key-value.
   */
  key: string;
  /**
   * Label that groups key-values (e.g. an environment name). Changing it
   * replaces the key-value.
   * @default no label
   */
  label?: string;
  /**
   * The value. Pass a `Redacted` for secrets so it never appears in logs or
   * state attributes.
   * @default ""
   */
  value?: string | Redacted.Redacted<string>;
  /**
   * Content type of the value, e.g. `application/json` or
   * `application/vnd.microsoft.appconfig.keyvaultref+json;charset=utf-8`
   * for a Key Vault reference.
   * @default none
   */
  contentType?: string;
  /**
   * Data-plane tags of the key-value. Alchemy ownership tags
   * (`alchemy::stack`, `alchemy::stage`, `alchemy::id`) are merged in.
   * @default {}
   */
  tags?: Record<string, string>;
}

export interface KeyValue extends Resource<
  "Azure.AppConfiguration.KeyValue",
  KeyValueProps,
  {
    /** The key. */
    key: string;
    /** The label, if any. */
    label: string | undefined;
    /** ARM name of the key-value (`<key>$<label>`, with `/` encoded as `~2F`). */
    keyValueName: string;
    /** Configuration store that holds the key-value. */
    configurationStore: string;
    /** Resource group of the configuration store. */
    resourceGroup: string;
    /** ARM resource ID of the key-value. */
    keyValueId: string;
    /** Content type of the value. */
    contentType: string | undefined;
    /** ETag of the current revision. */
    etag: string | undefined;
    /** Last time the key-value was modified. */
    lastModified: string | undefined;
    /** Whether the key-value is locked (read-only). */
    locked: boolean;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A key-value (setting) in an Azure App Configuration store
 * (`Microsoft.AppConfiguration/configurationStores/keyValues`), managed
 * through Azure Resource Manager.
 *
 * A setting is a key plus an optional label; the same key can hold one
 * value per label, e.g. one per environment. Key-values have no ARM tags,
 * so Alchemy records ownership in the key-value's data-plane tags. If the
 * store disables local auth, ARM only proxies key-value operations when the
 * store's `dataPlaneProxy.authenticationMode` is `Pass-through` and the
 * deployer holds the `App Configuration Data Owner` role on the store.
 *
 * :::caution[Changing `key`, `label`, `configurationStore`, or `resourceGroup` replaces the key-value]
 * Alchemy writes the new setting and deletes the old one. Runtimes that
 * read the old key or label get nothing.
 * :::
 *
 * @see https://learn.microsoft.com/azure/azure-app-configuration/concept-key-value
 *
 * ### Creating Key-Values
 * **Example:** Plain setting
 * ```typescript
 * const store = yield* Azure.AppConfiguration.ConfigurationStore("config");
 * yield* Azure.AppConfiguration.KeyValue("color", {
 *   configurationStore: store.configurationStoreName,
 *   key: "App:Settings:Color",
 *   label: "prod",
 *   value: "blue",
 * });
 * ```
 *
 * **Example:** JSON value
 * ```typescript
 * yield* Azure.AppConfiguration.KeyValue("limits", {
 *   configurationStore: store.configurationStoreName,
 *   key: "App:Limits",
 *   value: JSON.stringify({ maxUsers: 100 }),
 *   contentType: "application/json",
 * });
 * ```
 *
 * **Example:** Secret value
 * ```typescript
 * yield* Azure.AppConfiguration.KeyValue("token", {
 *   configurationStore: store.configurationStoreName,
 *   key: "App:Token",
 *   value: Config.redacted("APP_TOKEN"),
 * });
 * ```
 *
 * ### Key Vault References
 * Keep the secret in Key Vault and store a reference to it. App
 * Configuration client libraries resolve the reference; the reader also
 * needs access to the secret.
 *
 * **Example:** Reference a Key Vault secret
 * ```typescript
 * import * as Output from "alchemy/Output";
 *
 * const password = yield* Azure.KeyVault.Secret("db-password", {
 *   vault: vault.vaultName,
 *   value: Config.redacted("DB_PASSWORD"),
 * });
 * yield* Azure.AppConfiguration.KeyValue("db-password-ref", {
 *   configurationStore: store.configurationStoreName,
 *   key: "Db:Password",
 *   value: password.secretUri.pipe(Output.map((uri) => JSON.stringify({ uri }))),
 *   contentType: "application/vnd.microsoft.appconfig.keyvaultref+json;charset=utf-8",
 * });
 * ```
 *
 * ### Feature Flags
 * A feature flag is a key-value under `.appconfig.featureflag/` with the
 * feature-flag content type.
 *
 * **Example:** Turn on a beta feature
 * ```typescript
 * yield* Azure.AppConfiguration.KeyValue("beta-flag", {
 *   configurationStore: store.configurationStoreName,
 *   key: ".appconfig.featureflag/Beta",
 *   value: JSON.stringify({ id: "Beta", enabled: true, conditions: { client_filters: [] } }),
 *   contentType: "application/vnd.microsoft.appconfig.ff+json;charset=utf-8",
 * });
 * ```
 *
 * ### Reading Settings at Runtime
 * Bind the store, not the key-value: `ConfigurationStoreRead` grants a
 * custom role with only `keyValues/read` on the store.
 *
 * **Example:** Read a setting in an Azure Function
 * ```typescript
 * // init
 * const config = yield* Azure.AppConfiguration.ConfigurationStoreRead(store);
 *
 * // runtime
 * const color = yield* config.get("App:Settings:Color", { label: "prod" });
 * const value = color?.value ?? "blue";
 * // …provided with Effect.provide(Azure.AppConfiguration.ConfigurationStoreReadHttp)
 * ```
 *
 * A value a runtime writes with `ConfigurationStoreWrite` is not tracked by
 * this resource: the next deploy writes the declared value again only if
 * that value changed.
 *
 * ### Deleting a Key-Value
 * Destroying the resource deletes the setting (that key and label only).
 *
 * @resource
 */
export const KeyValue = GroupedResource<KeyValue>("Azure.AppConfiguration.KeyValue");

/** ARM key-value name: `key$label`, with `/` encoded as `~2F`. */
export const keyValueName = (key: string, label: string | undefined) => {
  const encodedKey = key.replaceAll("/", "~2F");
  return label === undefined || label === ""
    ? encodedKey
    : `${encodedKey}$${label.replaceAll("/", "~2F")}`;
};

const getKeyValue = (
  subscriptionId: string,
  resourceGroupName: string,
  configStoreName: string,
  name: string,
) =>
  orUndefinedIfNotFound(
    appconfiguration.GetKeyValue({
      subscriptionId,
      resourceGroupName,
      configStoreName,
      keyValueName: name,
    }),
  );

const reveal = (value: string | Redacted.Redacted<string> | undefined) =>
  value === undefined ? "" : Redacted.isRedacted(value) ? Redacted.value(value) : value;

const toAttrs = (
  resourceGroup: string,
  configurationStore: string,
  key: string,
  label: string | undefined,
  observed: appconfiguration.KeyValue,
): KeyValue["Attributes"] => ({
  key,
  label: label === "" ? undefined : label,
  keyValueName: keyValueName(key, label),
  configurationStore,
  resourceGroup,
  keyValueId: observed.id ?? "",
  contentType: observed.properties?.contentType || undefined,
  etag: observed.properties?.eTag,
  lastModified: observed.properties?.lastModified,
  locked: observed.properties?.locked ?? false,
  tags: userTags(observed.properties?.tags),
});

export const KeyValueProvider = () =>
  Provider.succeed(KeyValue, {
    stables: ["key", "label", "keyValueName", "configurationStore", "resourceGroup", "keyValueId"],

    // Key-values live inside a store; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !== output.resourceGroup.toLowerCase() ||
        news.configurationStore !== output.configurationStore ||
        news.key !== output.key ||
        (news.label || undefined) !== output.label
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const store = output?.configurationStore ?? olds?.configurationStore;
      const key = output?.key ?? olds?.key;
      if (resourceGroup === undefined || store === undefined || key === undefined) {
        return undefined;
      }
      const label = output?.label ?? olds?.label;
      const observed = yield* getKeyValue(
        subscriptionId,
        resourceGroup,
        store,
        keyValueName(key, label),
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, store, key, label, observed);
      return (yield* isOwned(id, observed.properties?.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.AppConfiguration");
      const { resourceGroup, configurationStore, key } = news;
      const label = news.label || undefined;
      const name = keyValueName(key, label);
      const value = reveal(news.value);
      const contentType = news.contentType ?? "";
      const tags = yield* desiredTags(id, news.tags);

      // Observe.
      let observed = yield* getKeyValue(subscriptionId, resourceGroup, configurationStore, name);

      // Ensure + sync. The PUT is a full upsert, so it doubles as the update;
      // skip it when the observed value, content type, and tags already match.
      if (
        observed === undefined ||
        (observed.properties?.value ?? "") !== value ||
        (observed.properties?.contentType ?? "") !== contentType ||
        tagsDiffer(observed.properties?.tags, tags)
      ) {
        observed = yield* appconfiguration.KeyValuesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          configStoreName: configurationStore,
          keyValueName: name,
          properties: { value, contentType, tags },
        });
      }

      return toAttrs(resourceGroup, configurationStore, key, label, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        appconfiguration.DeleteKeyValue({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          configStoreName: output.configurationStore,
          keyValueName: output.keyValueName,
        }),
      );
      yield* waitUntilGone(
        `app configuration key-value ${output.keyValueName}`,
        getKeyValue(
          subscriptionId,
          output.resourceGroup,
          output.configurationStore,
          output.keyValueName,
        ),
        { interval: "2 seconds", times: 15 },
      );
    }),
  });
