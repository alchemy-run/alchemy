import * as operationalinsights from "@distilled.cloud/azure/operationalinsights";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { isWorkspaceOwnedByStack, sameText } from "./Common.ts";

export type LinkedStorageDataSourceType =
  | "CustomLogs"
  | "AzureWatson"
  | "Query"
  | "Ingestion"
  | "Alerts";

export interface LinkedStorageAccountProps {
  /** Resource group of the workspace. Changing it replaces the link. */
  resourceGroup: string;
  /** Workspace to link storage to. Changing it replaces the link. */
  workspace: string;
  /**
   * Data the linked storage holds — also the link's name, so a workspace
   * has at most one link per type. Changing it replaces the link.
   */
  dataSourceType: LinkedStorageDataSourceType;
  /**
   * ARM resource IDs of the storage accounts to link. Each account must be
   * in the workspace's region and let trusted Azure services bypass its
   * network rules (`networkAcls.bypass` includes `AzureServices`); Azure
   * otherwise rejects the link as `LinkedStorageAccountFaulted`.
   */
  storageAccountIds: string[];
}

export interface LinkedStorageAccount extends Resource<
  "Azure.LogAnalytics.LinkedStorageAccount",
  LinkedStorageAccountProps,
  {
    /** Data source type (the link's name). */
    dataSourceType: string;
    /** Workspace the storage is linked to. */
    workspace: string;
    /** Resource group of the workspace. */
    resourceGroup: string;
    /** ARM resource ID of the link. */
    linkedStorageAccountId: string;
    /** Linked storage account IDs. */
    storageAccountIds: string[];
  },
  never,
  Providers
> {}

/**
 * Customer-managed storage linked to a Log Analytics workspace for one
 * kind of data (saved queries, alerts, custom logs, ingestion), e.g. to
 * keep saved queries in your own storage account encrypted with your keys.
 *
 * A workspace has one link per data source type and links have no tags;
 * Alchemy treats a link as owned when its workspace is owned by the
 * current stack and stage.
 *
 * @see https://learn.microsoft.com/azure/azure-monitor/logs/private-storage
 *
 * ### Linking Storage
 * **Example:** Keep saved queries in your own storage account
 * ```typescript
 * const queries = yield* Azure.Storage.StorageAccount("queries", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * yield* Azure.LogAnalytics.LinkedStorageAccount("queries", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: logs.workspaceName,
 *   dataSourceType: "Query",
 *   storageAccountIds: [queries.storageAccountId],
 * });
 * ```
 *
 * @resource
 */
export const LinkedStorageAccount = Resource<LinkedStorageAccount>(
  "Azure.LogAnalytics.LinkedStorageAccount",
);

type ObservedLink = operationalinsights.GetLinkedStorageAccountResponse;

const getLink = (
  subscriptionId: string,
  resourceGroupName: string,
  workspaceName: string,
  dataSourceType: string,
) =>
  orUndefinedIfNotFound(
    operationalinsights.GetLinkedStorageAccount({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      dataSourceType,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  workspace: string,
  dataSourceType: string,
  link: ObservedLink,
): LinkedStorageAccount["Attributes"] => ({
  dataSourceType,
  workspace,
  resourceGroup,
  linkedStorageAccountId: link.id ?? "",
  storageAccountIds: [...(link.properties.storageAccountIds ?? [])],
});

const sortedLower = (values: ReadonlyArray<string> | undefined) =>
  JSON.stringify([...(values ?? [])].map((v) => v.toLowerCase()).sort());

export const LinkedStorageAccountProvider = () =>
  Provider.succeed(LinkedStorageAccount, {
    stables: [
      "dataSourceType",
      "workspace",
      "resourceGroup",
      "linkedStorageAccountId",
    ],

    // Links live inside a workspace; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameText(news.resourceGroup, output.resourceGroup) ||
        !sameText(news.workspace, output.workspace) ||
        !sameText(news.dataSourceType, output.dataSourceType)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const workspace = output?.workspace ?? olds?.workspace;
      const dataSourceType = output?.dataSourceType ?? olds?.dataSourceType;
      if (
        resourceGroup === undefined ||
        workspace === undefined ||
        dataSourceType === undefined
      ) {
        return undefined;
      }
      const observed = yield* getLink(
        subscriptionId,
        resourceGroup,
        workspace,
        dataSourceType,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, workspace, dataSourceType, observed);
      return (yield* isWorkspaceOwnedByStack(
        subscriptionId,
        resourceGroup,
        workspace,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.OperationalInsights");
      const { resourceGroup, workspace, dataSourceType } = news;

      // Observe.
      let observed = yield* getLink(
        subscriptionId,
        resourceGroup,
        workspace,
        dataSourceType,
      );

      // Ensure + sync: the PUT is a synchronous upsert of the account list.
      if (
        observed === undefined ||
        sortedLower(observed.properties.storageAccountIds) !==
          sortedLower(news.storageAccountIds)
      ) {
        observed = yield* operationalinsights.LinkedStorageAccountsCreateOrUpdate(
          {
            subscriptionId,
            resourceGroupName: resourceGroup,
            workspaceName: workspace,
            dataSourceType,
            properties: { storageAccountIds: news.storageAccountIds },
          },
        );
      }

      return toAttrs(resourceGroup, workspace, dataSourceType, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        operationalinsights.DeleteLinkedStorageAccount({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          workspaceName: output.workspace,
          dataSourceType: output.dataSourceType,
        }),
      );
      yield* waitUntilGone(
        `linked storage ${output.dataSourceType}`,
        getLink(
          subscriptionId,
          output.resourceGroup,
          output.workspace,
          output.dataSourceType,
        ),
      );
    }),
  });
