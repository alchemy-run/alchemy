import { createHash } from "node:crypto";
import * as operationalinsights from "@distilled.cloud/azure/operationalinsights";
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
import { createLogAnalyticsName, sameText } from "./Common.ts";

export interface StorageInsightConfigProps {
  /**
   * Resource group of the workspace.
   *
   * :::caution
   * Changing it replaces the config.
   * :::
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
  resourceGroup: string;
  /**
   * Name of the workspace that reads the storage, e.g.
   * `logs.workspaceName`.
   *
   * :::caution
   * Changing it replaces the config.
   * :::
   */
  workspace: string;
  /**
   * Config name: letters, digits, hyphens, and underscores, unique in the
   * workspace.
   *
   * :::caution
   * Changing it replaces the config.
   * :::
   * @default a name generated from the app, stage, and logical ID
   */
  name?: string;
  /**
   * ARM resource ID of the storage account to read diagnostics from, e.g.
   * `account.storageAccountId`.
   *
   * :::caution
   * Changing it replaces the config.
   * :::
   */
  storageAccountId: string;
  /**
   * Access key of the storage account. Azure never returns it, so Alchemy
   * stores its SHA-256 hash and sends the key again whenever the hash
   * changes (for example after you rotate the key).
   */
  storageAccountKey: Redacted.Redacted<string>;
  /**
   * Blob containers to read, e.g. `["wad-iis-logfiles"]`. Alchemy updates
   * the list in place.
   * @default no containers
   */
  containers?: string[];
  /**
   * Storage tables to read, e.g. `["WADWindowsEventLogsTable"]`. Alchemy
   * updates the list in place.
   * @default no tables
   */
  tables?: string[];
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   * @default {}
   */
  tags?: Record<string, string>;
}

export interface StorageInsightConfig extends Resource<
  "Azure.LogAnalytics.StorageInsightConfig",
  StorageInsightConfigProps,
  {
    /** Name of the config. */
    storageInsightConfigName: string;
    /** Name of the workspace that reads the storage. */
    workspace: string;
    /** Resource group of the workspace. */
    resourceGroup: string;
    /** ARM resource ID of the config. */
    storageInsightConfigId: string;
    /** ARM resource ID of the storage account the workspace reads from. */
    storageAccountId: string;
    /** SHA-256 hash of the last storage key sent (Azure never returns the key). */
    storageAccountKeyHash: string;
    /** Read status: `OK` or `ERROR`. */
    state: string | undefined;
    /** Description of the read status, e.g. why a read failed. */
    stateDescription: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A storage insight config
 * (`Microsoft.OperationalInsights/workspaces/storageInsightConfigs`): it
 * makes a Log Analytics workspace read the Azure Diagnostics data (WAD
 * tables and IIS log containers) that VMs and cloud services write to a
 * storage account.
 *
 * :::caution[Changing `name`, `storageAccountId`, `workspace`, or `resourceGroup` replaces the config]
 * Alchemy creates the new config and deletes the old one. Change the key,
 * `containers`, `tables`, or `tags` to update it in place.
 * :::
 *
 * :::caution[You supply the storage account key]
 * `Azure.Storage.StorageAccount` does not return its access keys. Read a
 * key from config (or the portal) and pass it as a `Redacted` value. When
 * you rotate the key in Azure, deploy again with the new key, or the
 * config's `state` turns `ERROR`.
 * :::
 *
 * This is a legacy ingestion path. For new collection, use data collection
 * rules with the Azure Monitor agent.
 *
 * @see https://learn.microsoft.com/azure/azure-monitor/agents/diagnostics-extension-logs
 *
 * ### Reading Diagnostics from Storage
 * **Example:** Read Windows event logs and IIS logs
 * ```typescript
 * const logs = yield* Azure.LogAnalytics.Workspace("logs");
 * const account = yield* Azure.Storage.StorageAccount("diagnostics");
 * yield* Azure.LogAnalytics.StorageInsightConfig("diagnostics", {
 *   workspace: logs.workspaceName,
 *   storageAccountId: account.storageAccountId,
 *   storageAccountKey: yield* Config.redacted("DIAGNOSTICS_STORAGE_KEY"),
 *   tables: ["WADWindowsEventLogsTable"],
 *   containers: ["wad-iis-logfiles"],
 * });
 * ```
 *
 * @resource
 */
export const StorageInsightConfig = GroupedResource<StorageInsightConfig>(
  "Azure.LogAnalytics.StorageInsightConfig",
);

type ObservedConfig = operationalinsights.GetStorageInsightConfigResponse;

const getConfig = (
  subscriptionId: string,
  resourceGroupName: string,
  workspaceName: string,
  storageInsightName: string,
) =>
  orUndefinedIfNotFound(
    operationalinsights.GetStorageInsightConfig({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      storageInsightName,
    }),
  );

const hashKey = (key: Redacted.Redacted<string>) =>
  Effect.sync(() => createHash("sha256").update(Redacted.value(key)).digest("hex"));

const toAttrs = (
  resourceGroup: string,
  workspace: string,
  name: string,
  keyHash: string,
  config: ObservedConfig,
): StorageInsightConfig["Attributes"] => ({
  storageInsightConfigName: name,
  workspace,
  resourceGroup,
  storageInsightConfigId: config.id ?? "",
  storageAccountId: config.properties?.storageAccount.id ?? "",
  storageAccountKeyHash: keyHash,
  state: config.properties?.status?.state,
  stateDescription: config.properties?.status?.description,
  tags: userTags(config.tags),
});

const sortedLower = (values: ReadonlyArray<string> | undefined) =>
  JSON.stringify([...(values ?? [])].map((v) => v.toLowerCase()).sort());

export const StorageInsightConfigProvider = () =>
  Provider.succeed(StorageInsightConfig, {
    stables: ["storageInsightConfigName", "workspace", "resourceGroup", "storageInsightConfigId"],

    // Configs live inside a workspace; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameText(news.resourceGroup, output.resourceGroup) ||
        !sameText(news.workspace, output.workspace) ||
        (news.name !== undefined && !sameText(news.name, output.storageInsightConfigName)) ||
        !sameText(news.storageAccountId, output.storageAccountId)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const workspace = output?.workspace ?? olds?.workspace;
      if (resourceGroup === undefined || workspace === undefined) {
        return undefined;
      }
      const name =
        output?.storageInsightConfigName ?? olds?.name ?? (yield* createLogAnalyticsName(id, 63));
      const observed = yield* getConfig(subscriptionId, resourceGroup, workspace, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(
        resourceGroup,
        workspace,
        name,
        output?.storageAccountKeyHash ?? "",
        observed,
      );
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.OperationalInsights");
      const { resourceGroup, workspace } = news;
      const name =
        news.name ?? output?.storageInsightConfigName ?? (yield* createLogAnalyticsName(id, 63));
      const tags = yield* desiredTags(id, news.tags);
      const keyHash = yield* hashKey(news.storageAccountKey);

      // Observe.
      let observed = yield* getConfig(subscriptionId, resourceGroup, workspace, name);

      // Ensure + sync: the PUT is a synchronous upsert of the whole config
      // and must carry the key, which GET never returns; compare its hash.
      const current = observed?.properties;
      if (
        observed === undefined ||
        output?.storageAccountKeyHash !== keyHash ||
        sortedLower(current?.containers) !== sortedLower(news.containers) ||
        sortedLower(current?.tables) !== sortedLower(news.tables) ||
        tagsDiffer(observed.tags, tags)
      ) {
        observed = yield* operationalinsights.StorageInsightConfigsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          workspaceName: workspace,
          storageInsightName: name,
          eTag: observed?.eTag,
          tags,
          properties: {
            storageAccount: {
              id: news.storageAccountId,
              key: Redacted.value(news.storageAccountKey),
            },
            containers: news.containers,
            tables: news.tables,
          },
        });
      }

      return toAttrs(resourceGroup, workspace, name, keyHash, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        operationalinsights.DeleteStorageInsightConfig({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          workspaceName: output.workspace,
          storageInsightName: output.storageInsightConfigName,
        }),
      );
      yield* waitUntilGone(
        `storage insight config ${output.storageInsightConfigName}`,
        getConfig(
          subscriptionId,
          output.resourceGroup,
          output.workspace,
          output.storageInsightConfigName,
        ),
      );
    }),
  });
