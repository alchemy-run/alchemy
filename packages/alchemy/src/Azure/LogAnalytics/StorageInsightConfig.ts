import * as operationalinsights from "@distilled.cloud/azure/operationalinsights";
import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
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
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { createLogAnalyticsName, sameText } from "./Common.ts";

export interface StorageInsightConfigProps {
  /** Resource group of the workspace. Changing it replaces the config. */
  resourceGroup: string;
  /** Workspace that reads the storage. Changing it replaces the config. */
  workspace: string;
  /**
   * Config name. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the config.
   */
  name?: string;
  /**
   * ARM resource ID of the storage account to read diagnostics from.
   * Changing it replaces the config.
   */
  storageAccountId: string;
  /**
   * Access key of the storage account. Azure never returns it, so Alchemy
   * resends it whenever its hash changes.
   */
  storageAccountKey: Redacted.Redacted<string>;
  /** Blob containers to read, e.g. `["wad-iis-logfiles"]`. */
  containers?: string[];
  /** Tables to read, e.g. `["WADWindowsEventLogsTable"]`. */
  tables?: string[];
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface StorageInsightConfig extends Resource<
  "Azure.LogAnalytics.StorageInsightConfig",
  StorageInsightConfigProps,
  {
    /** Name of the config. */
    storageInsightConfigName: string;
    /** Workspace that reads the storage. */
    workspace: string;
    /** Resource group of the workspace. */
    resourceGroup: string;
    /** ARM resource ID of the config. */
    storageInsightConfigId: string;
    /** Storage account the workspace reads from. */
    storageAccountId: string;
    /** SHA-256 of the last storage key sent (the key is never returned). */
    storageAccountKeyHash: string;
    /** Read status (`OK` or `ERROR`). */
    state: string | undefined;
    /** Description of the read status. */
    stateDescription: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A storage insight config: has a Log Analytics workspace read Azure
 * Diagnostics data (WAD tables and IIS log containers) that classic VMs
 * and cloud services write to a storage account.
 *
 * This is a legacy ingestion path; new collection should use data
 * collection rules with the Azure Monitor agent.
 *
 * @see https://learn.microsoft.com/azure/azure-monitor/agents/diagnostics-extension-logs
 *
 * ### Reading Diagnostics from Storage
 * **Example:** Read Windows event logs and IIS logs
 * ```typescript
 * yield* Azure.LogAnalytics.StorageInsightConfig("diagnostics", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: logs.workspaceName,
 *   storageAccountId: account.storageAccountId,
 *   storageAccountKey: Redacted.make(accountKey),
 *   tables: ["WADWindowsEventLogsTable"],
 *   containers: ["wad-iis-logfiles"],
 * });
 * ```
 *
 * @resource
 */
export const StorageInsightConfig = Resource<StorageInsightConfig>(
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
  Effect.sync(() =>
    createHash("sha256").update(Redacted.value(key)).digest("hex"),
  );

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
    stables: [
      "storageInsightConfigName",
      "workspace",
      "resourceGroup",
      "storageInsightConfigId",
    ],

    // Configs live inside a workspace; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameText(news.resourceGroup, output.resourceGroup) ||
        !sameText(news.workspace, output.workspace) ||
        (news.name !== undefined &&
          !sameText(news.name, output.storageInsightConfigName)) ||
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
        output?.storageInsightConfigName ??
        olds?.name ??
        (yield* createLogAnalyticsName(id, 63));
      const observed = yield* getConfig(
        subscriptionId,
        resourceGroup,
        workspace,
        name,
      );
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
        news.name ??
        output?.storageInsightConfigName ??
        (yield* createLogAnalyticsName(id, 63));
      const tags = yield* desiredTags(id, news.tags);
      const keyHash = yield* hashKey(news.storageAccountKey);

      // Observe.
      let observed = yield* getConfig(
        subscriptionId,
        resourceGroup,
        workspace,
        name,
      );

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
        observed = yield* operationalinsights.StorageInsightConfigsCreateOrUpdate(
          {
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
          },
        );
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
