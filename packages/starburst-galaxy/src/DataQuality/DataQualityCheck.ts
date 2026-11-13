import * as galaxy from "@distilled.cloud/starburst-galaxy";
import type {
  CreateDataQualityCheckRequestCategory,
  CreateDataQualityCheckRequestSeverity,
  DataQualityCheckDetails,
} from "@distilled.cloud/starburst-galaxy/data_quality";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import {
  changedFields,
  collectAll,
  findFirst,
  GOVERNANCE_NAME,
  hasChanges,
  isGeneratedName,
  ownership,
  physicalName,
} from "../internal.ts";
import type { Providers } from "../Providers.ts";

export interface DataQualityCheckProps {
  /**
   * Check name. Renaming updates the check in place.
   * @default generated from the stack, logical id and stage (lowercase, `_`-delimited)
   */
  readonly name?: string;
  /** ID of the catalog holding the table. Changing it replaces the check. */
  readonly catalogId: string;
  /** Schema holding the table. Changing it replaces the check. */
  readonly schemaName: string;
  /** Table the check watches. Changing it replaces the check. */
  readonly tableName: string;
  /**
   * `QualityExpression`: a data quality expression over the table's
   * statistics, e.g. `row_count_min(1000)` (the table must have been
   * analyzed). `SqlQuery`: a SQL query returning one boolean, run on
   * `clusterId`. Changing it replaces the check.
   */
  readonly kind: "QualityExpression" | "SqlQuery";
  /** The expression or SQL query. */
  readonly query: string;
  /** How bad a failure is. */
  readonly severity: CreateDataQualityCheckRequestSeverity;
  /**
   * What the check measures.
   * @default "None"
   */
  readonly category?: CreateDataQualityCheckRequestCategory;
  /**
   * Description shown in Galaxy.
   * @default ""
   */
  readonly description?: string;
  /**
   * ID of the cluster that runs a `SqlQuery` check (required for one).
   * Galaxy never reports it back, so a change is detected against the last
   * deploy and sent.
   */
  readonly clusterId?: string;
}

export interface DataQualityCheckAttributes {
  /** Galaxy's check ID. */
  readonly dataQualityCheckId: string;
  /** Check name. */
  readonly name: string;
  /** Catalog holding the table. */
  readonly catalogId: string;
  /** Schema holding the table. */
  readonly schemaName: string;
  /** Table the check watches. */
  readonly tableName: string;
  /** `QualityExpression` or `SqlQuery`. */
  readonly kind: string;
  /** The expression or SQL query. */
  readonly query: string;
  /** How bad a failure is. */
  readonly severity: string;
  /** What the check measures. */
  readonly category: string;
  /** Description shown in Galaxy. */
  readonly description: string | undefined;
  /**
   * Cluster that validates and runs a SQL check, as last deployed: Galaxy
   * never returns it.
   */
  readonly clusterId: string | undefined;
}

export type DataQualityCheck = Resource<
  "StarburstGalaxy.DataQuality.DataQualityCheck",
  DataQualityCheckProps,
  DataQualityCheckAttributes,
  never,
  Providers
>;

/** Galaxy accepted a check create but the check could not be read back. */
export class DataQualityCheckNotResolved extends Data.TaggedError(
  "StarburstGalaxy.DataQualityCheckNotResolved",
)<{ readonly checkName: string }> {
  override get message() {
    return `Data quality check ${this.checkName} could not be found after it was created`;
  }
}

/**
 * A Starburst Galaxy data quality check: a rule on one table, evaluated on
 * the table's schedule (`StarburstGalaxy.DataQuality.DataQualitySchedule`) or on demand
 * (`StarburstGalaxy.DataQuality.EvaluateDataQualityCheck`).
 *
 * Name, query, severity, category, description and cluster update in
 * place; the table and the kind replace the check. Galaxy validates a
 * check on every write. An expression needs table statistics: run
 * `ANALYZE` on the table first, e.g. from a `SqlJob` (connectors that
 * can't collect statistics, such as PostgreSQL, take SQL checks only). A
 * SQL check needs `clusterId`, a cluster with the table's catalog
 * attached, and, when the table has a `DataQualitySchedule`, a schedule
 * role that may read the table.
 *
 * Checks have no labels or tags in Galaxy: a check Alchemy created is
 * recognized by its generated name.
 *
 * @see https://docs.starburst.io/starburst-galaxy/data-engineering/optimization-performance-and-quality/observability/profile-and-quality.html
 *
 * ### Checking table statistics
 * **Example:** The orders table is never empty and always has a customer
 * ```typescript
 * const shop = StarburstGalaxy.Catalog.PostgresqlCatalog.lookup({ name: "shop" });
 * yield* StarburstGalaxy.DataQuality.DataQualityCheck("OrdersPresent", {
 *   catalogId: shop.catalogId,
 *   schemaName: "sales",
 *   tableName: "orders",
 *   kind: "QualityExpression",
 *   query: 'row_count_min(1) AND nulls_fraction_max("customer", 0)',
 *   severity: "High",
 *   category: "Completeness",
 * });
 * ```
 *
 * ### Running SQL on a cluster
 * **Example:** No order has a negative amount
 * ```typescript
 * const shop = StarburstGalaxy.Catalog.PostgresqlCatalog.lookup({ name: "shop" });
 * const cluster = yield* StarburstGalaxy.Cluster.Cluster("Quality", { cloudRegionId: "aws-us-east1" });
 * yield* StarburstGalaxy.DataQuality.DataQualityCheck("NoNegativeAmounts", {
 *   catalogId: shop.catalogId,
 *   schemaName: "sales",
 *   tableName: "orders",
 *   kind: "SqlQuery",
 *   query: "SELECT count(*) = 0 FROM shop.sales.orders WHERE amount < 0",
 *   severity: "Critical",
 *   category: "Validity",
 *   clusterId: cluster.clusterId,
 * });
 * ```
 *
 * @resource
 * @product Data quality
 */
export const DataQualityCheck = Resource<DataQualityCheck>(
  "StarburstGalaxy.DataQuality.DataQualityCheck",
);

const toAttributes = (
  check: DataQualityCheckDetails,
  clusterId: string | undefined = undefined,
): DataQualityCheckAttributes => ({
  dataQualityCheckId: check.dataQualityCheckId,
  name: check.name,
  catalogId: check.catalogId,
  schemaName: check.schemaId,
  tableName: check.tableId,
  kind: check.kind,
  query: check.query,
  severity: check.severity,
  category: check.category,
  description: check.description,
  clusterId,
});

const getCheck = (dataQualityCheckId: string) =>
  galaxy.dataQuality
    .getDataQualityCheck({ dataQualityCheckId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const observe = Effect.fn(function* (
  dataQualityCheckId: string | undefined,
  name: string,
  table: { readonly catalogId: string; readonly schemaName: string; readonly tableName: string },
) {
  if (dataQualityCheckId !== undefined) {
    const byId = yield* getCheck(dataQualityCheckId);
    if (byId !== undefined) return byId;
  }
  const listed = yield* findFirst(
    galaxy.dataQuality.listDataQualityChecks.items({
      catalogId: table.catalogId,
      schemaId: table.schemaName,
      tableId: table.tableName,
    }),
    (check) => check.name === name,
  );
  return listed === undefined ? undefined : yield* getCheck(listed.dataQualityCheckId);
});

export const DataQualityCheckProvider = () =>
  Provider.succeed(DataQualityCheck, {
    stables: ["dataQualityCheckId", "catalogId", "schemaName", "tableName", "kind"],

    nuke: { dependsOn: ["StarburstGalaxy.Catalog.*", "StarburstGalaxy.Cluster.Cluster"] },

    diff: Effect.fn(function* ({ news, olds }) {
      if (!isResolved(news)) return undefined;
      if (
        news.catalogId !== olds.catalogId ||
        news.schemaName !== olds.schemaName ||
        news.tableName !== olds.tableName ||
        news.kind !== olds.kind
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output, previous }) {
      const name = output?.name ?? (yield* physicalName(id, olds?.name, GOVERNANCE_NAME));
      const check = yield* observe(output?.dataQualityCheckId, name, output ?? olds);
      if (check === undefined) return undefined;
      return ownership(toAttributes(check, output?.clusterId ?? olds?.clusterId), {
        output,
        explicitName: olds?.name,
        previous,
        key: "dataQualityCheckId",
      });
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output, session }) {
      const name = yield* physicalName(id, news.name, GOVERNANCE_NAME);
      const desired = {
        name,
        query: news.query,
        severity: news.severity,
        category: news.category ?? "None",
        description: news.description ?? "",
      };

      // Observe
      let check = yield* observe(output?.dataQualityCheckId, name, news);

      // Ensure: a create carries the whole desired state.
      if (check === undefined) {
        yield* session.note(`Creating data quality check ${name}...`);
        const created = yield* galaxy.dataQuality
          .createDataQualityCheck({
            ...desired,
            catalogId: news.catalogId,
            schemaId: news.schemaName,
            tableId: news.tableName,
            kind: news.kind,
            clusterId: news.clusterId,
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.undefined));
        check = created ?? (yield* observe(undefined, name, news));
        if (check === undefined) return yield* new DataQualityCheckNotResolved({ checkName: name });
        return toAttributes(check, news.clusterId);
      }

      // Sync: fields Galaxy reports against it; the write-only cluster against the
      // last deploy. Galaxy validates a SQL check on every update, so the cluster
      // goes with each one ("ClusterId is required to validate data quality SQL check").
      const delta = changedFields({ ...check, description: check.description ?? "" }, desired);
      const clusterChanged = news.clusterId !== undefined && news.clusterId !== olds?.clusterId;
      if (hasChanges(delta) || clusterChanged) {
        yield* session.note(`Updating data quality check ${name}...`);
        check = yield* galaxy.dataQuality.updateDataQualityCheck({
          ...delta,
          ...(news.clusterId !== undefined ? { clusterId: news.clusterId } : {}),
          dataQualityCheckId: check.dataQualityCheckId,
        });
      }
      return toAttributes(check, news.clusterId);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* galaxy.dataQuality
        .deleteDataQualityCheck({ dataQualityCheckId: output.dataQualityCheckId })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),

    list: () =>
      galaxy.dataQuality.listDataQualityChecks.items({}).pipe(
        Stream.filter((check) => isGeneratedName(check.name)),
        Stream.mapEffect((listed) => getCheck(listed.dataQualityCheckId)),
        Stream.filter((check): check is DataQualityCheckDetails => check !== undefined),
        (checks) => collectAll(checks, (check) => toAttributes(check)),
      ),
  });
