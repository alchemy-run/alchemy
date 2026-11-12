import { createHash } from "node:crypto";
import * as backup from "@distilled.cloud/clickhouse-cloud/backup";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { organizationId as currentOrganizationId } from "../Credentials.ts";
import { requireResult } from "../Errors.ts";
import type { Providers } from "../Providers.ts";

/** An S3 bucket the service assumes an IAM role to write to. */
export interface AwsBucket {
  bucketProvider: "AWS";
  /** The bucket's HTTPS URL and prefix, e.g. `https://my-backups.s3.amazonaws.com/analytics` (`s3://` URLs are refused). */
  bucketPath: string;
  /** ARN of the IAM role the service assumes (trust the service's `iamRole`). */
  iamRoleArn: string;
  /** Session name used when assuming the role. */
  iamRoleSessionName?: string;
  /** External ID the role's trust policy requires. */
  iamRoleExternalId?: string;
}

/** A GCS bucket written with an HMAC key. */
export interface GcpBucket {
  bucketProvider: "GCP";
  /** `https://storage.googleapis.com/bucket/prefix`. */
  bucketPath: string;
  /** HMAC access key ID. */
  accessKeyId: string;
  /** HMAC secret. Write-only. */
  secretAccessKey: Redacted.Redacted<string>;
}

/** An Azure Blob container written with a connection string. */
export interface AzureBucket {
  bucketProvider: "AZURE";
  /** Container name. */
  containerName: string;
  /** Storage account connection string. Write-only. */
  connectionString: Redacted.Redacted<string>;
}

export type BackupBucketProps = {
  /** ID of the service, e.g. a `ClickHouseCloud.Service.Service`'s `serviceId`. Changing it replaces the resource. */ serviceId: string;
} & (AwsBucket | GcpBucket | AzureBucket);

export interface BackupBucketAttributes {
  /** Service ID. */
  serviceId: string;
  /** Organization ID. */
  organizationId: string;
  /** Bucket configuration ID. */
  bucketId: string;
  /** `AWS`, `GCP` or `AZURE`. */
  bucketProvider: string | undefined;
  /** Bucket path (AWS, GCP). */
  bucketPath: string | undefined;
  /** IAM role ARN (AWS). */
  iamRoleArn: string | undefined;
  /** IAM role session name (AWS). */
  iamRoleSessionName: string | undefined;
  /** IAM role external ID (AWS). */
  iamRoleExternalId: string | undefined;
  /** HMAC key ID (GCP). */
  accessKeyId: string | undefined;
  /** Container (Azure). */
  containerName: string | undefined;
  /** SHA-256 of the last write-only secret applied, to detect a change. */
  secretDigest: Redacted.Redacted<string> | undefined;
}

export type BackupBucket = Resource<
  "ClickHouseCloud.Backup.BackupBucket",
  BackupBucketProps,
  BackupBucketAttributes,
  never,
  Providers
>;

/**
 * Your own bucket that a service writes its backups to, instead of
 * ClickHouse's: an S3 bucket through an IAM role, a GCS bucket through an
 * HMAC key, or an Azure Blob container through a connection string. The
 * endpoints are in beta.
 *
 * A service has at most one bucket. Readable settings converge from the
 * bucket ClickHouse reports; the GCP and Azure secrets are write-only, so a
 * change is detected from the digest of the last value applied (every
 * update resends them, as the API requires). Destroying the resource goes
 * back to ClickHouse's own storage. Needs an Admin key.
 * @see https://clickhouse.com/docs/cloud/manage/backups/export-backups-to-own-cloud-account
 *
 * ### Backing Up to S3
 * **Example:** An IAM role the service assumes
 * ```typescript
 * const analytics = yield* ClickHouseCloud.Service.Service("Analytics", {
 *   provider: "aws",
 *   region: "us-east-1",
 *   ipAccessList: [{ source: "0.0.0.0/0" }],
 * });
 * yield* ClickHouseCloud.Backup.BackupBucket("AnalyticsBackups", {
 *   serviceId: analytics.serviceId,
 *   bucketProvider: "AWS",
 *   bucketPath: "https://my-backups.s3.amazonaws.com/analytics",
 *   iamRoleArn: "arn:aws:iam::123456789012:role/clickhouse-backups",
 * });
 * ```
 *
 * ### Backing Up to GCS
 * **Example:** An HMAC key kept in a secret
 * ```typescript
 * yield* ClickHouseCloud.Backup.BackupBucket("AnalyticsBackups", {
 *   serviceId: analytics.serviceId,
 *   bucketProvider: "GCP",
 *   bucketPath: "https://storage.googleapis.com/my-backups/analytics",
 *   accessKeyId: "GOOG1E…",
 *   secretAccessKey: yield* Config.redacted("GCS_HMAC_SECRET"),
 * });
 * ```
 *
 * :::caution
 * Changing `serviceId` or `bucketProvider` replaces the resource.
 * :::
 *
 * Uses ClickHouse Cloud API endpoints marked Beta: `createBackupBucket`, `deleteBackupBucket`, `getBackupBucket`, `updateBackupBucket`.
 *
 * @resource
 * @product Backup
 */
export const BackupBucket = Resource<BackupBucket>("ClickHouseCloud.Backup.BackupBucket");

const digestOf = (props: BackupBucketProps) => {
  const secret =
    props.bucketProvider === "GCP"
      ? props.secretAccessKey
      : props.bucketProvider === "AZURE"
        ? props.connectionString
        : undefined;
  return secret === undefined
    ? undefined
    : Redacted.make(createHash("sha256").update(Redacted.value(secret)).digest("hex"));
};

const toAttributes = (
  organizationId: string,
  serviceId: string,
  bucket: backup.BackupBucket,
  secretDigest: Redacted.Redacted<string> | undefined,
): BackupBucketAttributes => ({
  serviceId,
  organizationId,
  bucketId: bucket.id ?? "",
  bucketProvider: bucket.bucketProvider,
  bucketPath: "bucketPath" in bucket ? bucket.bucketPath : undefined,
  iamRoleArn: "iamRoleArn" in bucket ? bucket.iamRoleArn : undefined,
  iamRoleSessionName: "iamRoleSessionName" in bucket ? bucket.iamRoleSessionName : undefined,
  iamRoleExternalId: "iamRoleExternalId" in bucket ? bucket.iamRoleExternalId : undefined,
  accessKeyId: "accessKeyId" in bucket ? bucket.accessKeyId : undefined,
  containerName: "containerName" in bucket ? bucket.containerName : undefined,
  secretDigest,
});

/** The request body: every field of the bucket provider, secrets included. */
const bodyOf = (props: BackupBucketProps): backup.BackupBucketPostRequest => {
  switch (props.bucketProvider) {
    case "AWS":
      return {
        bucketProvider: "AWS",
        bucketPath: props.bucketPath,
        iamRoleArn: props.iamRoleArn,
        iamRoleSessionName: props.iamRoleSessionName,
        iamRoleExternalId: props.iamRoleExternalId,
      };
    case "GCP":
      return {
        bucketProvider: "GCP",
        bucketPath: props.bucketPath,
        accessKeyId: props.accessKeyId,
        secretAccessKey: props.secretAccessKey,
      };
    case "AZURE":
      return {
        bucketProvider: "AZURE",
        containerName: props.containerName,
        connectionString: props.connectionString,
      };
  }
};

/** Whether the readable fields ClickHouse reports match the props. */
const matches = (attrs: BackupBucketAttributes, props: BackupBucketProps) => {
  switch (props.bucketProvider) {
    case "AWS":
      return (
        attrs.bucketPath === props.bucketPath &&
        attrs.iamRoleArn === props.iamRoleArn &&
        (attrs.iamRoleSessionName ?? undefined) === props.iamRoleSessionName &&
        (attrs.iamRoleExternalId ?? undefined) === props.iamRoleExternalId
      );
    case "GCP":
      return attrs.bucketPath === props.bucketPath && attrs.accessKeyId === props.accessKeyId;
    case "AZURE":
      return attrs.containerName === props.containerName;
  }
};

const getBucket = (organizationId: string, serviceId: string) =>
  backup.getBackupBucket({ organizationId, serviceId }).pipe(
    Effect.flatMap(requireResult("getBackupBucket")),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

export const BackupBucketProvider = () =>
  Provider.effect(
    BackupBucket,
    Effect.succeed({
      stables: ["serviceId", "organizationId"],
      nuke: { singleton: true, dependsOn: ["ClickHouseCloud.Service.Service"] },
      list: () => Effect.succeed([]),
      diff: Effect.fn(function* ({ news, olds }) {
        if (!isResolved(news) || olds === undefined) return undefined;
        if (news.serviceId !== olds.serviceId || news.bucketProvider !== olds.bucketProvider) {
          // One bucket per service: remove the old one first.
          return { action: "replace", deleteFirst: true } as const;
        }
        return undefined;
      }),
      read: Effect.fn(function* ({ olds, output }) {
        const organizationId = output?.organizationId ?? (yield* currentOrganizationId);
        const serviceId = output?.serviceId ?? olds.serviceId;
        const bucket = yield* getBucket(organizationId, serviceId);
        return bucket === undefined
          ? undefined
          : toAttributes(organizationId, serviceId, bucket, output?.secretDigest);
      }),
      reconcile: Effect.fn(function* ({ news, output }) {
        const organizationId = output?.organizationId ?? (yield* currentOrganizationId);
        const { serviceId } = news;
        const secretDigest = digestOf(news);
        // Observe
        const observed = yield* getBucket(organizationId, serviceId);
        // Ensure
        if (observed === undefined) {
          const created = yield* backup
            .createBackupBucket({ organizationId, serviceId, body: bodyOf(news) })
            .pipe(Effect.flatMap(requireResult("createBackupBucket")));
          return toAttributes(organizationId, serviceId, created, secretDigest);
        }
        // Sync: readable fields from the bucket, secrets from their digest.
        const attrs = toAttributes(organizationId, serviceId, observed, output?.secretDigest);
        const secretChanged =
          (secretDigest === undefined ? undefined : Redacted.value(secretDigest)) !==
          (attrs.secretDigest === undefined ? undefined : Redacted.value(attrs.secretDigest));
        if (
          attrs.bucketProvider === news.bucketProvider &&
          matches(attrs, news) &&
          !secretChanged
        ) {
          return attrs;
        }
        const body: backup.BackupBucketPatchRequest =
          news.bucketProvider === "AWS"
            ? {
                ...bodyOf(news),
                iamRoleSessionName: news.iamRoleSessionName ?? null,
                iamRoleExternalId: news.iamRoleExternalId ?? null,
              }
            : bodyOf(news);
        const updated = yield* backup
          .updateBackupBucket({ organizationId, serviceId, body })
          .pipe(Effect.flatMap(requireResult("updateBackupBucket")));
        return toAttributes(organizationId, serviceId, updated, secretDigest);
      }),
      delete: Effect.fn(function* ({ output }) {
        yield* backup
          .deleteBackupBucket({
            organizationId: output.organizationId,
            serviceId: output.serviceId,
          })
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
      }),
    }),
  );
