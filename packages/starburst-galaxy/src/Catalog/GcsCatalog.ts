import * as galaxy from "@distilled.cloud/starburst-galaxy";
import type {
  CreateGcsCatalogRequest,
  GcsCatalog as GcsCatalogShape,
  GcsCatalogPatch,
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

/** Galaxy's own metastore: Galaxy keeps the table metadata. */
export interface GcsGalaxyMetastore {
  readonly type: "galaxy";
  /** GCS bucket new schemas store their data in. */
  readonly defaultBucket: string;
  /** Path in `defaultBucket` new schemas store their data under. */
  readonly defaultDataLocation: string;
}

/** A Hive metastore service Galaxy can reach. */
export interface GcsHiveMetastore {
  readonly type: "hive";
  /** Host of the Hive metastore. */
  readonly host: string;
  /**
   * Port of the Hive metastore.
   * @default 9083
   */
  readonly port?: number;
  /** ID of a Galaxy SSH tunnel to reach the metastore through. */
  readonly sshTunnelId?: string;
}

export type GcsMetastore = GcsGalaxyMetastore | GcsHiveMetastore;

export interface GcsCatalogProps extends CatalogBaseProps {
  /**
   * Where table metadata lives. Changing `type` replaces the catalog: the
   * tables' metadata stays in the old metastore.
   */
  readonly metastore: GcsMetastore;
  /**
   * JSON key of the Google Cloud service account Galaxy reads and writes
   * the bucket as (plain JSON or base64). Galaxy checks with Google that
   * the account exists, even with `validate: false`. It never returns the
   * key: a change is detected by comparing the new value with the deployed one.
   */
  readonly credentialsKey: Redacted.Redacted<string>;
  /**
   * Table format `CREATE TABLE` uses when it names none.
   * @default "ICEBERG"
   */
  readonly defaultTableFormat?: "ICEBERG" | "DELTA" | "HIVE";
  /**
   * Allow `CREATE TABLE … WITH (location = …)` over existing data.
   * @default false
   */
  readonly externalTableCreationEnabled?: boolean;
  /**
   * Allow writes to external tables.
   * @default false
   */
  readonly externalTableWritesEnabled?: boolean;
  /** How stale cached table metadata may be, in seconds. */
  readonly metadataMaxStalenessSeconds?: 30 | 60 | 90 | 120;
}

export interface GcsCatalogAttributes extends CatalogBaseAttributes {
  /** The metastore as Galaxy reports it. */
  readonly metastore: GcsMetastore;
  /** Default table format. */
  readonly defaultTableFormat: string | undefined;
  /** Whether external tables may be created. */
  readonly externalTableCreationEnabled: boolean | undefined;
  /** Whether external tables may be written. */
  readonly externalTableWritesEnabled: boolean | undefined;
  /** Metadata staleness bound in seconds. */
  readonly metadataMaxStalenessSeconds: number | undefined;
}

export type GcsCatalog = Resource<
  "StarburstGalaxy.GcsCatalog",
  GcsCatalogProps,
  GcsCatalogAttributes,
  never,
  Providers,
  CatalogLookup
>;

/**
 * A Starburst Galaxy lakehouse catalog over a Google Cloud Storage
 * bucket: Iceberg, Delta Lake and Hive tables whose metadata lives in
 * Galaxy's own metastore or in a Hive metastore.
 *
 * Every setting except the metastore type updates in place, the name
 * included. Galaxy never returns the service account key, so a rotated key
 * is detected by comparing the deployed value with the new one.
 *
 * Catalogs have no labels or tags in Galaxy: a catalog Alchemy created is
 * recognized by its generated name.
 *
 * @see https://docs.starburst.io/starburst-galaxy/working-with-data/create-catalogs/object-storage/gcs.html
 *
 * ### Creating a lakehouse catalog
 * **Example:** Iceberg tables in a bucket, metadata in Galaxy
 * ```typescript
 * const credentialsKey = yield* Config.Redacted("LAKE_SERVICE_ACCOUNT_JSON");
 * const lake = yield* StarburstGalaxy.GcsCatalog("Lake", {
 *   credentialsKey,
 *   metastore: {
 *     type: "galaxy",
 *     defaultBucket: "analytics-lake",
 *     defaultDataLocation: "warehouse",
 *   },
 * });
 * yield* StarburstGalaxy.Cluster("Analytics", {
 *   cloudRegionId: "gcp-us-east1",
 *   catalogs: [lake.catalogId],
 * });
 * ```
 *
 * ### Using a Hive metastore
 * **Example:** An existing Hive metastore
 * ```typescript
 * const credentialsKey = yield* Config.Redacted("LAKE_SERVICE_ACCOUNT_JSON");
 * yield* StarburstGalaxy.GcsCatalog("Hive", {
 *   credentialsKey,
 *   defaultTableFormat: "HIVE",
 *   metastore: { type: "hive", host: "metastore.example.com" },
 * });
 * ```
 *
 * ### Looking up an existing catalog
 * **Example:** Reference a catalog created in the Galaxy console
 * ```typescript
 * const lake = StarburstGalaxy.GcsCatalog.lookup({ name: "lake" });
 * ```
 *
 * @resource
 * @product Catalogs
 */
export const GcsCatalog = Resource<GcsCatalog>("StarburstGalaxy.GcsCatalog");

const metastoreOf = (shape: GcsCatalogShape): GcsMetastore =>
  shape.metastoreType === "galaxy"
    ? {
        type: "galaxy",
        defaultBucket: shape.defaultBucket,
        defaultDataLocation: shape.defaultDataLocation,
      }
    : {
        type: "hive",
        host: shape.hiveMetastoreHost,
        port: shape.hiveMetastorePort,
        sshTunnelId: shape.sshTunnelId,
      };

/** The metastore's settings, as Galaxy names them. */
const metastoreSettingsOf = (metastore: GcsMetastore) =>
  metastore.type === "galaxy"
    ? {
        defaultBucket: metastore.defaultBucket,
        defaultDataLocation: metastore.defaultDataLocation,
      }
    : {
        hiveMetastoreHost: metastore.host,
        hiveMetastorePort: metastore.port,
        sshTunnelId: metastore.sshTunnelId,
      };

/** The non-secret settings, as Galaxy names them. */
const settingsOf = (name: string, props: GcsCatalogProps) => ({
  name,
  description: props.description ?? "",
  readOnly: props.readOnly ?? false,
  defaultTableFormat: props.defaultTableFormat,
  externalTableCreationEnabled: props.externalTableCreationEnabled,
  externalTableWritesEnabled: props.externalTableWritesEnabled,
  metadataMaxStalenessSeconds: props.metadataMaxStalenessSeconds,
  ...metastoreSettingsOf(props.metastore),
});

export const GcsCatalogProvider = () =>
  Provider.succeed(
    GcsCatalog,
    catalogLifecycle({
      kind: "GCS",
      get: (catalogId) =>
        galaxy.catalog
          .getGcsCatalog({ catalogId })
          .pipe(Effect.catchTag("NotFound", () => Effect.undefined)),
      create: (body: CreateGcsCatalogRequest) =>
        galaxy.catalog
          .createGcsCatalog({ body })
          .pipe(Effect.catchTag("Conflict", () => Effect.undefined)),
      update: (catalogId, body: GcsCatalogPatch) =>
        galaxy.catalog.updateGcsCatalog({ catalogId, body }),
      validate: (catalogId) => galaxy.catalog.validateGcsCatalog({ catalogId }),
      delete: (catalogId) =>
        galaxy.catalog.deleteGcsCatalog({ catalogId }).pipe(
          Effect.asVoid,
          Effect.catchTag("NotFound", () => Effect.void),
        ),
      list: galaxy.catalog.listGcsCatalogs.items({}),
      toCreate: (name, props) =>
        ({
          ...settingsOf(name, props),
          credentialsKey: props.credentialsKey,
          metastoreType: props.metastore.type,
          validate: props.validate ?? true,
        }) as CreateGcsCatalogRequest,
      toPatch: (name, props, observed, withSecrets) => {
        const delta = changedFields(
          { ...observed, description: observed.description ?? "" },
          settingsOf(name, props),
        );
        if (!hasChanges(delta) && !withSecrets) return undefined;
        return {
          ...delta,
          ...(withSecrets ? { credentialsKey: props.credentialsKey } : {}),
          metastoreType: props.metastore.type,
          validate: props.validate ?? true,
        } as GcsCatalogPatch;
      },
      toAttributes: (shape: GcsCatalogShape): GcsCatalogAttributes => ({
        catalogId: shape.catalogId,
        name: shape.name,
        description: shape.description,
        readOnly: shape.readOnly,
        metastore: metastoreOf(shape),
        defaultTableFormat: shape.defaultTableFormat,
        externalTableCreationEnabled: shape.externalTableCreationEnabled,
        externalTableWritesEnabled: shape.externalTableWritesEnabled,
        metadataMaxStalenessSeconds: shape.metadataMaxStalenessSeconds,
      }),
      secretsChanged: (olds, news) =>
        secretValue(olds.credentialsKey) !== secretValue(news.credentialsKey),
      replaces: (olds, news) => olds.metastore.type !== news.metastore.type,
    }),
  );
