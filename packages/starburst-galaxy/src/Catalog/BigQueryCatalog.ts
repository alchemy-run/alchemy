import * as galaxy from "@distilled.cloud/starburst-galaxy";
import type {
  BigQueryCatalog as BigQueryCatalogShape,
  CreateBigQueryCatalogRequest,
  UpdateBigQueryCatalogRequest,
} from "@distilled.cloud/starburst-galaxy/catalog";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { changedFields, hasChanges } from "../internal.ts";
import type { Providers } from "../Providers.ts";
import {
  type CatalogBaseAttributes,
  type CatalogBaseProps,
  catalogLifecycle,
  secretValue,
} from "./CatalogKind.ts";
import type { CatalogLookup } from "./PostgresqlCatalog.ts";

export interface BigQueryCatalogProps extends CatalogBaseProps {
  /**
   * JSON key of the Google Cloud service account Galaxy queries BigQuery
   * as (plain JSON or base64). Galaxy never returns it: a change is
   * detected by comparing the new value with the deployed one.
   */
  readonly credentialsKey: Redacted.Redacted<string>;
  /**
   * Project whose datasets the catalog exposes, when it differs from the
   * service account's project. Set it with `parentProjectId`.
   */
  readonly projectId?: string;
  /** Project billed for the queries, when it differs from the service account's project. */
  readonly parentProjectId?: string;
}

export interface BigQueryCatalogAttributes extends CatalogBaseAttributes {
  /** Project whose datasets the catalog exposes, if set. */
  readonly projectId: string | undefined;
  /** Project billed for the queries, if set. */
  readonly parentProjectId: string | undefined;
}

export type BigQueryCatalog = Resource<
  "StarburstGalaxy.BigQueryCatalog",
  BigQueryCatalogProps,
  BigQueryCatalogAttributes,
  never,
  Providers,
  CatalogLookup
>;

/**
 * A Starburst Galaxy catalog over Google BigQuery: datasets become
 * schemas, queried as `<catalog>.<dataset>.<table>` on every cluster the
 * catalog is attached to.
 *
 * Every setting, the name included, updates in place. Galaxy never returns
 * the service account key, so a rotated key is detected by comparing the
 * deployed value with the new one. Galaxy checks the key on every create
 * and update; set `validate: false` to store a catalog it cannot check yet.
 *
 * Catalogs have no labels or tags in Galaxy: a catalog Alchemy created is
 * recognized by its generated name.
 *
 * @see https://docs.starburst.io/starburst-galaxy/working-with-data/create-catalogs/non-object-storage/bigquery.html
 *
 * ### Creating a catalog
 * **Example:** A catalog over a service account's BigQuery project
 * ```typescript
 * const credentialsKey = yield* Config.Redacted("BIGQUERY_SERVICE_ACCOUNT_JSON");
 * const warehouse = yield* StarburstGalaxy.BigQueryCatalog("Warehouse", {
 *   credentialsKey,
 *   readOnly: true,
 * });
 * yield* StarburstGalaxy.Cluster("Analytics", {
 *   cloudRegionId: "gcp-us-east1",
 *   catalogs: [warehouse.catalogId],
 * });
 * ```
 *
 * ### Querying another project
 * **Example:** Expose one project's datasets, billed to another
 * ```typescript
 * const credentialsKey = yield* Config.Redacted("BIGQUERY_SERVICE_ACCOUNT_JSON");
 * yield* StarburstGalaxy.BigQueryCatalog("Public", {
 *   credentialsKey,
 *   projectId: "bigquery-public-data",
 *   parentProjectId: "my-billing-project",
 * });
 * ```
 *
 * ### Looking up an existing catalog
 * **Example:** Reference a catalog created in the Galaxy console
 * ```typescript
 * const warehouse = StarburstGalaxy.BigQueryCatalog.lookup({ name: "warehouse" });
 * ```
 *
 * @resource
 * @product Catalogs
 */
export const BigQueryCatalog = Resource<BigQueryCatalog>("StarburstGalaxy.BigQueryCatalog");

/** The non-secret settings, as Galaxy names them. */
const settingsOf = (name: string, props: BigQueryCatalogProps) => ({
  name,
  description: props.description ?? "",
  readOnly: props.readOnly ?? false,
  projectId: props.projectId,
  parentProjectId: props.parentProjectId,
});

export const BigQueryCatalogProvider = () =>
  Provider.succeed(
    BigQueryCatalog,
    catalogLifecycle({
      kind: "BigQuery",
      get: (catalogId) =>
        galaxy.catalog
          .getBigQueryCatalog({ catalogId })
          .pipe(Effect.catchTag("NotFound", () => Effect.undefined)),
      create: (request: CreateBigQueryCatalogRequest) =>
        galaxy.catalog
          .createBigQueryCatalog(request)
          .pipe(Effect.catchTag("Conflict", () => Effect.undefined)),
      update: (catalogId, patch: Omit<UpdateBigQueryCatalogRequest, "catalogId">) =>
        galaxy.catalog.updateBigQueryCatalog({ ...patch, catalogId }),
      validate: (catalogId) => galaxy.catalog.validateBigQueryCatalog({ catalogId }),
      delete: (catalogId) =>
        galaxy.catalog.deleteBigQueryCatalog({ catalogId }).pipe(
          Effect.asVoid,
          Effect.catchTag("NotFound", () => Effect.void),
        ),
      list: galaxy.catalog.listBigQueryCatalogs.items({}),
      toCreate: (name, props) => ({
        ...settingsOf(name, props),
        credentialsKey: props.credentialsKey,
        validate: props.validate ?? true,
      }),
      toPatch: (name, props, observed, withSecrets) => {
        const delta = changedFields(
          { ...observed, description: observed.description ?? "" },
          settingsOf(name, props),
        );
        if (!hasChanges(delta) && !withSecrets) return undefined;
        return {
          ...delta,
          ...(withSecrets ? { credentialsKey: props.credentialsKey } : {}),
          validate: props.validate ?? true,
        };
      },
      toAttributes: (shape: BigQueryCatalogShape): BigQueryCatalogAttributes => ({
        catalogId: shape.catalogId,
        name: shape.name,
        description: shape.description,
        readOnly: shape.readOnly,
        projectId: shape.projectId,
        parentProjectId: shape.parentProjectId,
      }),
      secretsChanged: (olds, news) =>
        secretValue(olds.credentialsKey) !== secretValue(news.credentialsKey),
    }),
  );
