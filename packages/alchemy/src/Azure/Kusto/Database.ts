import * as kusto from "@distilled.cloud/azure/azure_kusto";
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
import {
  clusterLocation,
  createKustoChildName,
  isClusterOwnedByStack,
  lower,
  untilConverged,
  whileClusterBusy,
} from "./common.ts";

export interface DatabaseProps {
  /** Resource group of the cluster. Changing it replaces the database. */
  resourceGroup: string;
  /** Name of the cluster that hosts the database. Changing it replaces the database. */
  cluster: string;
  /**
   * Database name, unique within the cluster. If omitted, a unique name is
   * generated from the app, stage, and logical ID. Changing it replaces the
   * database.
   */
  name?: string;
  /**
   * Azure location. Changing it replaces the database.
   * @default the cluster's location
   */
  location?: string;
  /**
   * How long data stays queryable before it is soft-deleted, as an ISO-8601
   * duration (e.g. `P365D`). Omit for unlimited retention.
   */
  softDeletePeriod?: string;
  /**
   * How long data stays in the hot cache, as an ISO-8601 duration (e.g.
   * `P31D`). Omit for unlimited caching.
   */
  hotCachePeriod?: string;
  /**
   * Whether the deploying principal becomes a database Admin. Applied only
   * when the database is created.
   * @default "Admin"
   */
  callerRole?: "Admin" | "None";
}

export interface Database extends Resource<
  "Azure.Kusto.Database",
  DatabaseProps,
  {
    /** Name of the database. */
    databaseName: string;
    /** ARM resource ID of the database. */
    databaseId: string;
    /** Cluster that hosts the database. */
    cluster: string;
    /** Resource group of the cluster. */
    resourceGroup: string;
    /** Location of the database. */
    location: string;
    /** Soft-delete period (ISO-8601 duration), if set. */
    softDeletePeriod: string | undefined;
    /** Hot-cache period (ISO-8601 duration), if set. */
    hotCachePeriod: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A read-write database in an Azure Data Explorer (Kusto) cluster, with
 * its data retention (soft-delete) and hot-cache policies.
 *
 * @see https://learn.microsoft.com/azure/data-explorer/create-cluster-and-database
 *
 * ### Creating a Database
 * **Example:** Database with retention and cache policies
 * ```typescript
 * const cluster = yield* Azure.Kusto.Cluster("adx", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const db = yield* Azure.Kusto.Database("telemetry", {
 *   resourceGroup: group.resourceGroupName,
 *   cluster: cluster.clusterName,
 *   softDeletePeriod: "P365D",
 *   hotCachePeriod: "P31D",
 * });
 * ```
 *
 * @resource
 */
export const Database = Resource<Database>("Azure.Kusto.Database");

const getDatabase = (
  subscriptionId: string,
  resourceGroupName: string,
  clusterName: string,
  databaseName: string,
) =>
  orUndefinedIfNotFound(
    kusto.GetDatabase({
      subscriptionId,
      resourceGroupName,
      clusterName,
      databaseName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  cluster: string,
  name: string,
  database: kusto.GetDatabaseResponse,
): Database["Attributes"] => ({
  databaseName: name,
  databaseId: database.id ?? "",
  cluster,
  resourceGroup,
  location: database.location ?? "",
  softDeletePeriod: database.properties?.softDeletePeriod,
  hotCachePeriod: database.properties?.hotCachePeriod,
});

export const DatabaseProvider = () =>
  Provider.succeed(Database, {
    stables: ["databaseName", "databaseId", "cluster", "resourceGroup"],

    // Databases live inside a cluster; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        news.cluster !== output.cluster ||
        (news.name !== undefined && news.name !== output.databaseName) ||
        (news.location !== undefined &&
          lower(news.location)?.replace(/\s/g, "") !==
            lower(output.location)?.replace(/\s/g, ""))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const cluster = output?.cluster ?? olds?.cluster;
      if (resourceGroup === undefined || cluster === undefined) {
        return undefined;
      }
      const name =
        output?.databaseName ?? olds?.name ?? (yield* createKustoChildName(id));
      const observed = yield* getDatabase(
        subscriptionId,
        resourceGroup,
        cluster,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, cluster, name, observed);
      return output !== undefined ||
        (yield* isClusterOwnedByStack(subscriptionId, resourceGroup, cluster))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Kusto");
      const { resourceGroup, cluster } = news;
      const name =
        news.name ?? output?.databaseName ?? (yield* createKustoChildName(id));
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        clusterName: cluster,
        databaseName: name,
      };
      const get = getDatabase(subscriptionId, resourceGroup, cluster, name);
      const waitReady = waitForProvisioned(
        `kusto database ${name}`,
        get,
        (db) => db.properties?.provisioningState,
        { interval: "5 seconds", times: 60 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        const location =
          news.location ??
          output?.location ??
          (yield* clusterLocation(subscriptionId, resourceGroup, cluster));
        yield* kusto
          .DatabasesCreateOrUpdate({
            ...where,
            callerRole: news.callerRole,
            location,
            kind: "ReadWrite",
            properties: {
              softDeletePeriod: news.softDeletePeriod,
              hotCachePeriod: news.hotCachePeriod,
            },
          })
          .pipe(Effect.retry(whileClusterBusy));
      }
      observed = yield* waitReady;

      // Sync retention and cache policies against observed state.
      const props = observed.properties ?? {};
      const changed: kusto.ReadWriteDatabaseProperties = {};
      if (
        news.softDeletePeriod !== undefined &&
        props.softDeletePeriod !== news.softDeletePeriod
      ) {
        changed.softDeletePeriod = news.softDeletePeriod;
      }
      if (
        news.hotCachePeriod !== undefined &&
        props.hotCachePeriod !== news.hotCachePeriod
      ) {
        changed.hotCachePeriod = news.hotCachePeriod;
      }
      if (Object.keys(changed).length > 0) {
        yield* kusto
          .UpdateDatabase({
            ...where,
            kind: "ReadWrite",
            properties: changed,
          })
          .pipe(Effect.retry(whileClusterBusy));
        observed = yield* waitForProvisioned(
          `kusto database ${name}`,
          get,
          untilConverged(
            (db) => db.properties?.provisioningState,
            (db) =>
              (changed.softDeletePeriod === undefined ||
                db.properties?.softDeletePeriod === changed.softDeletePeriod) &&
              (changed.hotCachePeriod === undefined ||
                db.properties?.hotCachePeriod === changed.hotCachePeriod),
          ),
          { interval: "5 seconds", times: 60 },
        );
      }

      return toAttrs(resourceGroup, cluster, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        kusto
          .DeleteDatabase({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            clusterName: output.cluster,
            databaseName: output.databaseName,
          })
          .pipe(Effect.retry(whileClusterBusy)),
      );
      yield* waitUntilGone(
        `kusto database ${output.databaseName}`,
        getDatabase(
          subscriptionId,
          output.resourceGroup,
          output.cluster,
          output.databaseName,
        ),
        { interval: "5 seconds", times: 60 },
      );
    }),
  });
