import * as galaxy from "@distilled.cloud/starburst-galaxy";
import type {
  CreateS3CatalogRequest,
  S3Catalog as S3CatalogShape,
  S3CatalogPatch,
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
  type CatalogLookup,
  catalogLifecycle,
  secretValue,
} from "./CatalogKind.ts";

/** Galaxy's own metastore: Galaxy keeps the table metadata. */
export interface S3GalaxyMetastore {
  readonly type: "galaxy";
  /** S3 bucket new schemas store their data in. */
  readonly defaultBucket: string;
  /** Path in `defaultBucket` new schemas store their data under. */
  readonly defaultDataLocation: string;
}

/** AWS Glue Data Catalog as the metastore. */
export interface S3GlueMetastore {
  readonly type: "glue";
  /** AWS region of the Glue Data Catalog, e.g. `us-east-1`. */
  readonly region: string;
  /** S3 bucket new schemas store their data in. */
  readonly defaultBucket: string;
  /** Path in `defaultBucket` new schemas store their data under. */
  readonly defaultDataLocation: string;
  /**
   * IAM role Galaxy assumes for Glue, when it differs from the catalog's `roleArn`.
   */
  readonly glueRoleArn?: string;
  /** Access key ID for Glue, when Glue uses keys rather than a role. */
  readonly glueAccessKey?: string;
  /** Secret access key for Glue. Galaxy never returns it. */
  readonly glueSecretKey?: Redacted.Redacted<string>;
}

/** A Hive metastore service Galaxy can reach. */
export interface S3HiveMetastore {
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

export type S3Metastore = S3GalaxyMetastore | S3GlueMetastore | S3HiveMetastore;

export interface S3CatalogProps extends CatalogBaseProps {
  /**
   * Where table metadata lives. Changing `type` replaces the catalog: the
   * tables' metadata stays in the old metastore.
   */
  readonly metastore: S3Metastore;
  /**
   * IAM role Galaxy assumes to read and write the bucket. The role must
   * trust Starburst's AWS account with Galaxy's external ID (see Galaxy →
   * Admin → Cloud settings). Use either a role or `accessKey`/`secretKey`.
   */
  readonly roleArn?: string;
  /** Access key ID Galaxy reads and writes the bucket with. */
  readonly accessKey?: string;
  /** Secret access key for `accessKey`. Galaxy never returns it. */
  readonly secretKey?: Redacted.Redacted<string>;
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

export interface S3CatalogAttributes extends CatalogBaseAttributes {
  /** The metastore as Galaxy reports it; secrets are never included. */
  readonly metastore: S3GalaxyMetastore | Omit<S3GlueMetastore, "glueSecretKey"> | S3HiveMetastore;
  /** IAM role Galaxy assumes for the bucket, if any. */
  readonly roleArn: string | undefined;
  /** Access key ID Galaxy uses for the bucket, if any. */
  readonly accessKey: string | undefined;
  /** Default table format. */
  readonly defaultTableFormat: string | undefined;
  /** Whether external tables may be created. */
  readonly externalTableCreationEnabled: boolean | undefined;
  /** Whether external tables may be written. */
  readonly externalTableWritesEnabled: boolean | undefined;
  /** Metadata staleness bound in seconds. */
  readonly metadataMaxStalenessSeconds: number | undefined;
}

export type S3Catalog = Resource<
  "StarburstGalaxy.S3Catalog",
  S3CatalogProps,
  S3CatalogAttributes,
  never,
  Providers,
  CatalogLookup
>;

/**
 * A Starburst Galaxy catalog over Amazon S3: an object-storage lakehouse
 * whose tables (Iceberg by default, or Delta Lake or Hive) are created and
 * queried with SQL on every cluster the catalog is attached to. Table
 * metadata lives in Galaxy's own metastore, in AWS Glue, or in a Hive
 * metastore.
 *
 * Settings update in place, the name included. Changing the metastore
 * `type` replaces the catalog. Galaxy never returns secret keys, so a
 * rotated key is detected by comparing the deployed value with the new
 * one. Clusters can only query an S3 catalog in their own cloud region.
 *
 * @see https://docs.starburst.io/starburst-galaxy/working-with-data/create-catalogs/object-storage/s3.html
 *
 * ### Creating a lakehouse catalog
 * **Example:** Galaxy metastore over a bucket, read through an IAM role
 * ```typescript
 * const lake = yield* AWS.S3.Bucket("Lake", {});
 * const lakehouse = yield* StarburstGalaxy.S3Catalog("Lakehouse", {
 *   roleArn: "arn:aws:iam::123456789012:role/galaxy-lake",
 *   metastore: {
 *     type: "galaxy",
 *     defaultBucket: lake.bucketName,
 *     defaultDataLocation: "warehouse",
 *   },
 * });
 * yield* StarburstGalaxy.Cluster("Analytics", {
 *   cloudRegionId: "aws-us-east1",
 *   catalogs: [lakehouse.catalogId],
 * });
 * ```
 *
 * ### Using AWS Glue as the metastore
 * **Example:** Iceberg tables registered in Glue, with access keys
 * ```typescript
 * const secretKey = yield* Config.Redacted("GALAXY_LAKE_SECRET_KEY");
 * yield* StarburstGalaxy.S3Catalog("Glue", {
 *   accessKey: "AKIAIOSFODNN7EXAMPLE",
 *   secretKey,
 *   defaultTableFormat: "ICEBERG",
 *   metastore: {
 *     type: "glue",
 *     region: "us-east-1",
 *     defaultBucket: "analytics-lake",
 *     defaultDataLocation: "iceberg",
 *   },
 * });
 * ```
 *
 * ### Using a Hive metastore
 * **Example:** A Hive metastore reached through an SSH tunnel
 * ```typescript
 * yield* StarburstGalaxy.S3Catalog("Hive", {
 *   roleArn: "arn:aws:iam::123456789012:role/galaxy-lake",
 *   defaultTableFormat: "HIVE",
 *   metastore: { type: "hive", host: "metastore.internal", sshTunnelId: "st-1234567890" },
 * });
 * ```
 *
 * ### Looking up an existing catalog
 * **Example:** Reference a catalog created in the Galaxy console
 * ```typescript
 * const lake = StarburstGalaxy.S3Catalog.lookup({ name: "lake" });
 * ```
 *
 * @resource
 * @product Catalogs
 */
export const S3Catalog = Resource<S3Catalog>("StarburstGalaxy.S3Catalog");

const metastoreOf = (shape: S3CatalogShape): S3CatalogAttributes["metastore"] =>
  shape.metastoreType === "galaxy"
    ? {
        type: "galaxy",
        defaultBucket: shape.defaultBucket,
        defaultDataLocation: shape.defaultDataLocation,
      }
    : shape.metastoreType === "glue"
      ? {
          type: "glue",
          region: shape.region,
          defaultBucket: shape.defaultBucket,
          defaultDataLocation: shape.defaultDataLocation,
          glueRoleArn: shape.glueRoleArn,
          glueAccessKey: shape.glueAccessKey,
        }
      : {
          type: "hive",
          host: shape.hiveMetastoreHost,
          port: shape.hiveMetastorePort,
          sshTunnelId: shape.sshTunnelId,
        };

const toAttributes = (shape: S3CatalogShape): S3CatalogAttributes => ({
  catalogId: shape.catalogId,
  name: shape.name,
  description: shape.description,
  readOnly: shape.readOnly,
  metastore: metastoreOf(shape),
  roleArn: shape.roleArn,
  accessKey: shape.accessKey,
  defaultTableFormat: shape.defaultTableFormat,
  externalTableCreationEnabled: shape.externalTableCreationEnabled,
  externalTableWritesEnabled: shape.externalTableWritesEnabled,
  metadataMaxStalenessSeconds: shape.metadataMaxStalenessSeconds,
});

/** Settings every metastore type shares, as Galaxy names them; no secrets. */
const commonSettingsOf = (name: string, props: S3CatalogProps) => ({
  name,
  description: props.description ?? "",
  readOnly: props.readOnly ?? false,
  roleArn: props.roleArn,
  accessKey: props.accessKey,
  defaultTableFormat: props.defaultTableFormat,
  externalTableCreationEnabled: props.externalTableCreationEnabled,
  externalTableWritesEnabled: props.externalTableWritesEnabled,
  metadataMaxStalenessSeconds: props.metadataMaxStalenessSeconds,
});

/** The metastore's settings, as Galaxy names them; no secrets. */
const metastoreSettingsOf = (metastore: S3Metastore) =>
  metastore.type === "galaxy"
    ? {
        defaultBucket: metastore.defaultBucket,
        defaultDataLocation: metastore.defaultDataLocation,
      }
    : metastore.type === "glue"
      ? {
          region: metastore.region,
          defaultBucket: metastore.defaultBucket,
          defaultDataLocation: metastore.defaultDataLocation,
          glueRoleArn: metastore.glueRoleArn,
          glueAccessKey: metastore.glueAccessKey,
        }
      : {
          hiveMetastoreHost: metastore.host,
          hiveMetastorePort: metastore.port,
          sshTunnelId: metastore.sshTunnelId,
        };

const secretsOf = (props: S3CatalogProps) => ({
  secretKey: props.secretKey,
  glueSecretKey: props.metastore.type === "glue" ? props.metastore.glueSecretKey : undefined,
});

export const S3CatalogProvider = () =>
  Provider.succeed(
    S3Catalog,
    catalogLifecycle({
      kind: "S3",
      get: (catalogId) =>
        galaxy.catalog
          .getS3Catalog({ catalogId })
          .pipe(Effect.catchTag("NotFound", () => Effect.undefined)),
      create: (body: CreateS3CatalogRequest) =>
        galaxy.catalog
          .createS3Catalog({ body })
          .pipe(Effect.catchTag("Conflict", () => Effect.undefined)),
      update: (catalogId, body: S3CatalogPatch) =>
        galaxy.catalog.updateS3Catalog({ catalogId, body }),
      validate: (catalogId) => galaxy.catalog.validateS3Catalog({ catalogId }),
      delete: (catalogId) =>
        galaxy.catalog.deleteS3Catalog({ catalogId }).pipe(
          Effect.asVoid,
          Effect.catchTag("NotFound", () => Effect.void),
        ),
      list: galaxy.catalog.listS3Catalogs.items({}),
      toCreate: (name, props): CreateS3CatalogRequest => {
        const fields = {
          ...commonSettingsOf(name, props),
          secretKey: props.secretKey,
          validate: props.validate ?? true,
        };
        const metastore = props.metastore;
        switch (metastore.type) {
          case "galaxy":
            return {
              ...fields,
              metastoreType: "galaxy",
              defaultBucket: metastore.defaultBucket,
              defaultDataLocation: metastore.defaultDataLocation,
            };
          case "glue":
            return {
              ...fields,
              metastoreType: "glue",
              region: metastore.region,
              defaultBucket: metastore.defaultBucket,
              defaultDataLocation: metastore.defaultDataLocation,
              glueRoleArn: metastore.glueRoleArn,
              glueAccessKey: metastore.glueAccessKey,
              glueSecretKey: metastore.glueSecretKey,
            };
          case "hive":
            return {
              ...fields,
              metastoreType: "hive",
              hiveMetastoreHost: metastore.host,
              hiveMetastorePort: metastore.port,
              sshTunnelId: metastore.sshTunnelId,
            };
        }
      },
      toPatch: (name, props, observed, withSecrets): S3CatalogPatch | undefined => {
        const delta = changedFields(
          { ...observed, description: observed.description ?? "" },
          { ...commonSettingsOf(name, props), ...metastoreSettingsOf(props.metastore) },
        );
        if (!hasChanges(delta) && !withSecrets) return undefined;
        const fields = {
          ...delta,
          ...(withSecrets ? secretsOf(props) : {}),
          validate: props.validate ?? true,
        };
        // The metastore type never changes in place (it replaces), so the patch uses the current one.
        switch (props.metastore.type) {
          case "galaxy":
            return { ...fields, metastoreType: "galaxy" };
          case "glue":
            return { ...fields, metastoreType: "glue" };
          case "hive":
            return { ...fields, metastoreType: "hive" };
        }
      },
      toAttributes,
      secretsChanged: (olds, news) =>
        secretValue(olds.secretKey) !== secretValue(news.secretKey) ||
        secretValue(secretsOf(olds).glueSecretKey) !== secretValue(secretsOf(news).glueSecretKey),
      replaces: (olds, news) => olds.metastore.type !== news.metastore.type,
    }),
  );
