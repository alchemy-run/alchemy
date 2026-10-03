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

export type TargetType = "SqlDb" | "SqlEp" | "SqlMi";

export interface TargetVault {
  /** ARM resource ID of the Key Vault holding the SQL login secrets. */
  akvResourceId: string;
  /** Name of the Key Vault secret storing the SQL login name. */
  akvTargetUser: string;
  /** Name of the Key Vault secret storing the SQL login password. */
  akvTargetPassword: string;
}

export interface TargetProps {
  /** Resource group of the watcher. Changing it replaces the target. */
  resourceGroup: string;
  /** Name of the watcher that monitors the target. Changing it replaces the target. */
  watcher: string;
  /**
   * Name of the target. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the target.
   */
  name?: string;
  /**
   * Kind of SQL resource monitored: a single database (`SqlDb`), an
   * elastic pool (`SqlEp`), or a managed instance (`SqlMi`). Changing it
   * replaces the target.
   */
  targetType: TargetType;
  /**
   * ARM resource ID of the database (`SqlDb`). Changing it replaces the
   * target.
   */
  sqlDbResourceId?: string;
  /**
   * ARM resource ID of the elastic pool (`SqlEp`). Changing it replaces
   * the target.
   */
  sqlEpResourceId?: string;
  /**
   * ARM resource ID of a database in the elastic pool used to connect to
   * it (`SqlEp`). Changing it replaces the target.
   */
  anchorDatabaseResourceId?: string;
  /**
   * ARM resource ID of the managed instance (`SqlMi`). Changing it
   * replaces the target.
   */
  sqlMiResourceId?: string;
  /**
   * Monitor the high-availability replica instead of the primary
   * (`SqlDb`, `SqlMi`). Changing it replaces the target.
   * @default false
   */
  readIntent?: boolean;
  /**
   * FQDN of the server used in the connection string, e.g.
   * `my-server.database.windows.net`.
   */
  connectionServerName: string;
  /** TCP port used to connect to a managed instance (`SqlMi`). */
  connectionTcpPort?: number;
  /**
   * How the watcher authenticates to the target: its managed identity
   * (`Aad`) or a SQL login read from Key Vault (`Sql`, requires
   * `targetVault`).
   * @default "Aad"
   */
  targetAuthenticationType?: "Aad" | "Sql";
  /** Key Vault secrets holding the SQL login when `targetAuthenticationType` is `Sql`. */
  targetVault?: TargetVault;
}

export interface Target extends Resource<
  "Azure.DatabaseWatcher.Target",
  TargetProps,
  {
    /** Name of the target. */
    targetName: string;
    /** Name of the watcher. */
    watcherName: string;
    /** Resource group of the watcher. */
    resourceGroup: string;
    /** ARM resource ID of the target. */
    targetId: string;
    /** Kind of SQL resource monitored. */
    targetType: string;
    /** Authentication type used to connect to the target. */
    targetAuthenticationType: string;
    /** FQDN of the server used in the connection string. */
    connectionServerName: string;
    /** Provisioning state of the target. */
    provisioningState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A SQL database, elastic pool, or managed instance monitored by a
 * database watcher.
 *
 * Targets cannot be tagged; Alchemy owns a target it created or whose
 * name it generated.
 *
 * @see https://learn.microsoft.com/azure/azure-sql/database-watcher-manage
 *
 * ### Monitoring a Database
 * **Example:** Watch a single Azure SQL database with Entra authentication
 * ```typescript
 * const target = yield* Azure.DatabaseWatcher.Target("orders-db", {
 *   resourceGroup: group.resourceGroupName,
 *   watcher: watcher.watcherName,
 *   targetType: "SqlDb",
 *   sqlDbResourceId: database.databaseId,
 *   connectionServerName: server.fullyQualifiedDomainName,
 * });
 * ```
 *
 * ### Monitoring an Elastic Pool
 * **Example:** Watch an elastic pool through an anchor database
 * ```typescript
 * const target = yield* Azure.DatabaseWatcher.Target("pool", {
 *   resourceGroup: group.resourceGroupName,
 *   watcher: watcher.watcherName,
 *   targetType: "SqlEp",
 *   sqlEpResourceId: pool.elasticPoolId,
 *   anchorDatabaseResourceId: database.databaseId,
 *   connectionServerName: server.fullyQualifiedDomainName,
 * });
 * ```
 *
 * @resource
 */
export const Target = Resource<Target>("Azure.DatabaseWatcher.Target");

const getTarget = (
  subscriptionId: string,
  resourceGroupName: string,
  watcherName: string,
  targetName: string,
) =>
  orUndefinedIfNotFound(
    databasewatcher.GetTarget({
      subscriptionId,
      resourceGroupName,
      watcherName,
      targetName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  watcherName: string,
  name: string,
  target: databasewatcher.GetTargetResponse,
): Target["Attributes"] => ({
  targetName: name,
  watcherName,
  resourceGroup,
  targetId: target.id ?? "",
  targetType: target.properties?.targetType ?? "",
  targetAuthenticationType: target.properties?.targetAuthenticationType ?? "",
  connectionServerName: target.properties?.connectionServerName ?? "",
  provisioningState: target.properties?.provisioningState,
});

const lower = (value: string | undefined) => (value ?? "").toLowerCase();

const toProperties = (news: TargetProps) => ({
  targetType: news.targetType,
  targetAuthenticationType: news.targetAuthenticationType ?? "Aad",
  targetVault: news.targetVault,
  connectionServerName: news.connectionServerName,
  sqlDbResourceId: news.sqlDbResourceId,
  sqlEpResourceId: news.sqlEpResourceId,
  anchorDatabaseResourceId: news.anchorDatabaseResourceId,
  sqlMiResourceId: news.sqlMiResourceId,
  connectionTcpPort: news.connectionTcpPort,
  readIntent: news.readIntent,
});

const differs = (
  observed: databasewatcher.TargetProperties | undefined,
  news: TargetProps,
) =>
  observed === undefined ||
  observed.targetAuthenticationType !==
    (news.targetAuthenticationType ?? "Aad") ||
  lower(observed.connectionServerName) !== lower(news.connectionServerName) ||
  (news.connectionTcpPort !== undefined &&
    observed.connectionTcpPort !== news.connectionTcpPort) ||
  lower(observed.targetVault?.akvResourceId) !==
    lower(news.targetVault?.akvResourceId) ||
  (observed.targetVault?.akvTargetUser ?? "") !==
    (news.targetVault?.akvTargetUser ?? "");

export const TargetProvider = () =>
  Provider.succeed(Target, {
    stables: ["targetName", "watcherName", "resourceGroup", "targetId"],

    // Targets live inside a watcher; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.watcher) !== lower(output.watcherName) ||
        (news.name !== undefined && news.name !== output.targetName) ||
        news.targetType !== output.targetType ||
        (olds !== undefined &&
          (lower(news.sqlDbResourceId) !== lower(olds.sqlDbResourceId) ||
            lower(news.sqlEpResourceId) !== lower(olds.sqlEpResourceId) ||
            lower(news.anchorDatabaseResourceId) !==
              lower(olds.anchorDatabaseResourceId) ||
            lower(news.sqlMiResourceId) !== lower(olds.sqlMiResourceId) ||
            (news.readIntent ?? false) !== (olds.readIntent ?? false)))
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
      const name = output?.targetName ?? olds?.name ?? generated;
      const observed = yield* getTarget(
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
        news.name ?? output?.targetName ?? (yield* createWatcherChildName(id));
      const get = getTarget(subscriptionId, resourceGroup, watcher, name);

      // Observe.
      let observed = yield* get;

      // Ensure + sync: the PUT is a synchronous full upsert, so one PUT
      // covers both a missing target and drifted mutable settings.
      if (observed === undefined || differs(observed.properties, news)) {
        yield* databasewatcher.TargetsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          watcherName: watcher,
          targetName: name,
          properties: toProperties(news),
        });
      }
      observed = yield* waitForProvisioned(
        `database watcher target ${name}`,
        get,
        (t) => t.properties?.provisioningState,
        { interval: "3 seconds", times: 20 },
      );
      return toAttrs(resourceGroup, watcher, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        databasewatcher.DeleteTarget({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          watcherName: output.watcherName,
          targetName: output.targetName,
        }),
      );
      yield* waitUntilGone(
        `database watcher target ${output.targetName}`,
        getTarget(
          subscriptionId,
          output.resourceGroup,
          output.watcherName,
          output.targetName,
        ),
      );
    }),

    nuke: { dependsOn: ["Azure.DatabaseWatcher.Watcher"] },
  });
