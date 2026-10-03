import * as databasewatcher from "@distilled.cloud/azure/databasewatcher";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { createWatcherChildName } from "./common.ts";

export type SharedPrivateLinkGroupId =
  | "sqlServer"
  | "managedInstance"
  | "cluster"
  | "vault";

export interface SharedPrivateLinkResourceProps {
  /** Resource group of the watcher. Changing it replaces the link. */
  resourceGroup: string;
  /** Name of the watcher. Changing it replaces the link. */
  watcher: string;
  /**
   * Name of the shared private link. If omitted, a unique name is
   * generated from the app, stage, and logical ID. Changing it replaces
   * the link.
   */
  name?: string;
  /**
   * ARM resource ID of the private-link-enabled resource: a SQL logical
   * server, SQL managed instance, Azure Data Explorer cluster, or Key
   * Vault. Changing it replaces the link.
   */
  privateLinkResourceId: string;
  /**
   * Private link sub-resource of the target: `sqlServer`,
   * `managedInstance`, `cluster`, or `vault`. Changing it replaces the
   * link.
   */
  groupId: SharedPrivateLinkGroupId;
  /**
   * Message shown to the owner of the target resource when approving the
   * private endpoint connection. Changing it replaces the link.
   * @default "Requested by Alchemy"
   */
  requestMessage?: string;
  /**
   * DNS zone segment of the target's host name. Required for Azure Data
   * Explorer clusters (e.g. `eastus`) and SQL managed instances (e.g.
   * `767d5869f605`); omit it for SQL logical servers and Key Vaults.
   * Changing it replaces the link.
   */
  dnsZone?: string;
}

export interface SharedPrivateLinkResource extends Resource<
  "Azure.DatabaseWatcher.SharedPrivateLinkResource",
  SharedPrivateLinkResourceProps,
  {
    /** Name of the shared private link. */
    sharedPrivateLinkResourceName: string;
    /** Name of the watcher. */
    watcherName: string;
    /** Resource group of the watcher. */
    resourceGroup: string;
    /** ARM resource ID of the shared private link. */
    id: string;
    /** ARM resource ID of the private-link-enabled resource. */
    privateLinkResourceId: string;
    /** Private link sub-resource of the target. */
    groupId: string;
    /**
     * Approval status of the private endpoint connection on the target:
     * `Pending`, `Approved`, `Rejected`, or `Disconnected`.
     */
    status: string | undefined;
    /** Provisioning state of the shared private link. */
    provisioningState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A managed private endpoint from a database watcher to a SQL server,
 * SQL managed instance, Azure Data Explorer cluster, or Key Vault, so the
 * watcher reaches its targets and data store without public network
 * access.
 *
 * The connection starts as `Pending`; approve it on the target resource
 * (e.g. with the target's private endpoint connection resource). Links
 * cannot be tagged; Alchemy owns a link it created or whose name it
 * generated. All properties are immutable.
 *
 * @see https://learn.microsoft.com/azure/azure-sql/database-watcher-manage#create-a-managed-private-endpoint
 *
 * ### Connecting Privately
 * **Example:** Private link to a SQL logical server
 * ```typescript
 * const link = yield* Azure.DatabaseWatcher.SharedPrivateLinkResource("sql", {
 *   resourceGroup: group.resourceGroupName,
 *   watcher: watcher.watcherName,
 *   privateLinkResourceId: server.serverId,
 *   groupId: "sqlServer",
 * });
 * ```
 *
 * **Example:** Private link to an Azure Data Explorer cluster
 * ```typescript
 * const link = yield* Azure.DatabaseWatcher.SharedPrivateLinkResource("adx", {
 *   resourceGroup: group.resourceGroupName,
 *   watcher: watcher.watcherName,
 *   privateLinkResourceId: cluster.clusterId,
 *   groupId: "cluster",
 *   dnsZone: "eastus",
 * });
 * ```
 *
 * @resource
 */
export const SharedPrivateLinkResource = Resource<SharedPrivateLinkResource>(
  "Azure.DatabaseWatcher.SharedPrivateLinkResource",
);

const getLink = (
  subscriptionId: string,
  resourceGroupName: string,
  watcherName: string,
  sharedPrivateLinkResourceName: string,
) =>
  orUndefinedIfNotFound(
    databasewatcher.GetSharedPrivateLinkResource({
      subscriptionId,
      resourceGroupName,
      watcherName,
      sharedPrivateLinkResourceName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  watcherName: string,
  name: string,
  link: databasewatcher.GetSharedPrivateLinkResourceResponse,
): SharedPrivateLinkResource["Attributes"] => ({
  sharedPrivateLinkResourceName: name,
  watcherName,
  resourceGroup,
  id: link.id ?? "",
  privateLinkResourceId: link.properties?.privateLinkResourceId ?? "",
  groupId: link.properties?.groupId ?? "",
  status: link.properties?.status,
  provisioningState: link.properties?.provisioningState,
});

const lower = (value: string | undefined) => (value ?? "").toLowerCase();

export const SharedPrivateLinkResourceProvider = () =>
  Provider.succeed(SharedPrivateLinkResource, {
    stables: [
      "sharedPrivateLinkResourceName",
      "watcherName",
      "resourceGroup",
      "id",
    ],

    // Links live inside a watcher; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.watcher) !== lower(output.watcherName) ||
        (news.name !== undefined &&
          news.name !== output.sharedPrivateLinkResourceName) ||
        lower(news.privateLinkResourceId) !==
          lower(output.privateLinkResourceId) ||
        lower(news.groupId) !== lower(output.groupId) ||
        (olds !== undefined &&
          ((news.requestMessage ?? "") !== (olds.requestMessage ?? "") ||
            lower(news.dnsZone) !== lower(olds.dnsZone)))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const watcherName = output?.watcherName ?? olds?.watcher;
      if (resourceGroup === undefined || watcherName === undefined) {
        return undefined;
      }
      const generated = yield* createWatcherChildName(id);
      const name =
        output?.sharedPrivateLinkResourceName ?? olds?.name ?? generated;
      const observed = yield* getLink(
        subscriptionId,
        resourceGroup,
        watcherName,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, watcherName, name, observed);
      return output !== undefined || name === generated
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.DatabaseWatcher");
      const { resourceGroup, watcher } = news;
      const name =
        news.name ??
        output?.sharedPrivateLinkResourceName ??
        (yield* createWatcherChildName(id));
      const get = getLink(subscriptionId, resourceGroup, watcher, name);

      // Observe.
      const observed = yield* get;

      // Ensure. Every property is immutable (changes replace the link).
      if (observed === undefined) {
        yield* databasewatcher.CreateSharedPrivateLinkResource({
          subscriptionId,
          resourceGroupName: resourceGroup,
          watcherName: watcher,
          sharedPrivateLinkResourceName: name,
          properties: {
            privateLinkResourceId: news.privateLinkResourceId,
            groupId: news.groupId,
            requestMessage: news.requestMessage ?? "Requested by Alchemy",
            dnsZone: news.dnsZone,
          },
        });
      }
      // Provisioning creates the managed private endpoint; approval on the
      // target happens out of band, so only wait for provisioning.
      const fresh = yield* waitForProvisioned(
        `database watcher shared private link ${name}`,
        get,
        (l) => l.properties?.provisioningState,
        { interval: "5 seconds", times: 60 },
      );
      return toAttrs(resourceGroup, watcher, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        databasewatcher.DeleteSharedPrivateLinkResource({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          watcherName: output.watcherName,
          sharedPrivateLinkResourceName: output.sharedPrivateLinkResourceName,
        }),
      );
      yield* waitUntilGone(
        `database watcher shared private link ${output.sharedPrivateLinkResourceName}`,
        getLink(
          subscriptionId,
          output.resourceGroup,
          output.watcherName,
          output.sharedPrivateLinkResourceName,
        ),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.DatabaseWatcher.Watcher"] },
  });
