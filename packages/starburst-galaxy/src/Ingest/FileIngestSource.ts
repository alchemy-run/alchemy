import * as galaxy from "@distilled.cloud/starburst-galaxy";
import type {
  CloudStorageCredentials,
  FileIngestSource as FileIngestSourceShape,
} from "@distilled.cloud/starburst-galaxy/file_ingest_source";
import { deepEqual, isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { secretValue } from "../Catalog/CatalogKind.ts";
import {
  changedFields,
  collectAll,
  DATA_DOMAIN_NAME,
  findFirst,
  hasChanges,
  isGeneratedName,
  ownership,
  physicalName,
} from "../internal.ts";
import type { Providers } from "../Providers.ts";

/** How Galaxy reads the bucket. */
export type FileIngestCredentials =
  | {
      /** An IAM role Galaxy assumes (see `StarburstGalaxy.CloudAccess.CrossAccountIamRole`). */
      readonly type: "externalIamRole";
      /** ARN of the role. */
      readonly roleArn: string;
    }
  | {
      /** An AWS access key. Prefer a role: a key is long-lived. */
      readonly type: "basicAwsCredentials";
      /** AWS access key ID. */
      readonly accessKeyId: string;
      /** AWS secret access key. Galaxy never returns it. */
      readonly secretAccessKey: Redacted.Redacted<string>;
    };

export interface FileIngestSourceProps {
  /**
   * Source name. Renaming updates the source in place.
   * @default generated from the stack, logical id and stage
   */
  readonly name?: string;
  /**
   * Description shown in Galaxy.
   * @default ""
   */
  readonly description?: string;
  /** S3 bucket the files land in. Changing it replaces the source. */
  readonly bucket: string;
  /** Galaxy cloud region of the bucket, e.g. `aws-us-east1`. Changing it replaces the source. */
  readonly bucketCloudRegionId: string;
  /** Key prefix of the files, e.g. `events/`. Changing it replaces the source. */
  readonly pathPrefix?: string;
  /** Galaxy cloud region that reads the files, when it differs from the bucket's. Changing it replaces the source. */
  readonly sourceCloudRegionId?: string;
  /**
   * How Galaxy reads the bucket. Galaxy never returns credentials: a change
   * is detected against the last deploy and sent.
   */
  readonly credentials: FileIngestCredentials;
}

export interface FileIngestSourceAttributes {
  /** Galaxy's source ID (`is-…`): pass it to a `LiveTable`. */
  readonly fileIngestSourceId: string;
  /** Source name. */
  readonly name: string;
  /** Description shown in Galaxy. */
  readonly description: string | undefined;
  /** S3 bucket the files land in. */
  readonly bucket: string;
  /** Key prefix of the files. */
  readonly pathPrefix: string | undefined;
}

export type FileIngestSource = Resource<
  "StarburstGalaxy.Ingest.FileIngestSource",
  FileIngestSourceProps,
  FileIngestSourceAttributes,
  never,
  Providers
>;

/** Galaxy accepted a source create but the source could not be read back. */
export class FileIngestSourceNotResolved extends Data.TaggedError(
  "StarburstGalaxy.FileIngestSourceNotResolved",
)<{ readonly sourceName: string }> {
  override get message() {
    return `File ingest source ${this.sourceName} could not be found after it was created`;
  }
}

/**
 * Where Starburst Galaxy picks up files for streaming ingestion: an S3
 * bucket and prefix, and how to read them. A `LiveTable` with file-ingest
 * properties loads the files into an Iceberg table.
 *
 * Name, description and credentials update in place; the bucket, prefix
 * and regions replace the source. The source itself reads nothing until a
 * live table uses it.
 *
 * Sources have no labels or tags in Galaxy: a source Alchemy created is
 * recognized by its generated name.
 *
 * @see https://docs.starburst.io/starburst-galaxy/working-with-data/data-ingest/configure-live-table-from-file.html
 *
 * ### Reading a bucket through an IAM role
 * **Example:** JSON events under a prefix
 * ```typescript
 * const role = yield* StarburstGalaxy.CloudAccess.CrossAccountIamRole("Ingest", {
 *   roleArn: "arn:aws:iam::123456789012:role/galaxy-ingest",
 * });
 * yield* StarburstGalaxy.Ingest.FileIngestSource("Events", {
 *   bucket: "acme-events",
 *   bucketCloudRegionId: "aws-us-east1",
 *   pathPrefix: "events/",
 *   credentials: { type: "externalIamRole", roleArn: role.roleArn },
 * });
 * ```
 *
 * @resource
 * @product Ingest
 */
export const FileIngestSource = Resource<FileIngestSource>(
  "StarburstGalaxy.Ingest.FileIngestSource",
);

const toAttributes = (source: FileIngestSourceShape): FileIngestSourceAttributes => ({
  fileIngestSourceId: source.fileIngestSourceId,
  name: source.name,
  description: source.description,
  bucket: source.bucket,
  pathPrefix: source.prefix,
});

const credentialsOf = (credentials: FileIngestCredentials): CloudStorageCredentials =>
  credentials.type === "externalIamRole"
    ? { credentialsType: "externalIamRole", externalRoleArn: credentials.roleArn }
    : {
        credentialsType: "basicAwsCredentials",
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
      };

/** Credentials as plain values, for comparing two deploys. */
const comparable = (credentials: FileIngestCredentials) =>
  credentials.type === "externalIamRole"
    ? credentials
    : { ...credentials, secretAccessKey: secretValue(credentials.secretAccessKey) };

const getSource = (fileIngestSourceId: string) =>
  galaxy.fileIngestSource
    .getFileIngestSource({ fileIngestSourceId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const findByName = (name: string) =>
  findFirst(galaxy.fileIngestSource.listFileIngestSources.items({}), (s) => s.name === name);

const observe = Effect.fn(function* (fileIngestSourceId: string | undefined, name: string) {
  if (fileIngestSourceId !== undefined) {
    const byId = yield* getSource(fileIngestSourceId);
    if (byId !== undefined) return byId;
  }
  return yield* findByName(name);
});

export const FileIngestSourceProvider = () =>
  Provider.succeed(FileIngestSource, {
    stables: ["fileIngestSourceId", "bucket", "pathPrefix"],

    nuke: { dependsOn: ["StarburstGalaxy.CloudAccess.CrossAccountIamRole"] },

    diff: Effect.fn(function* ({ news, olds }) {
      if (!isResolved(news)) return undefined;
      if (
        news.bucket !== olds.bucket ||
        news.bucketCloudRegionId !== olds.bucketCloudRegionId ||
        news.pathPrefix !== olds.pathPrefix ||
        news.sourceCloudRegionId !== olds.sourceCloudRegionId
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output, previous }) {
      const name = output?.name ?? (yield* physicalName(id, olds?.name, DATA_DOMAIN_NAME));
      const source = yield* observe(output?.fileIngestSourceId, name);
      if (source === undefined) return undefined;
      return ownership(toAttributes(source), {
        output,
        explicitName: olds?.name,
        previous,
        key: "fileIngestSourceId",
      });
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output, session }) {
      const name = yield* physicalName(id, news.name, DATA_DOMAIN_NAME);

      // Observe
      let source = yield* observe(output?.fileIngestSourceId, name);

      // Ensure
      if (source === undefined) {
        yield* session.note(`Creating file ingest source ${name}...`);
        const created = yield* galaxy.fileIngestSource
          .createFileIngestSource({
            name,
            description: news.description ?? "",
            bucket: news.bucket,
            bucketCloudRegionId: news.bucketCloudRegionId,
            pathPrefix: news.pathPrefix,
            sourceCloudRegionId: news.sourceCloudRegionId,
            cloudStorageCredentials: credentialsOf(news.credentials),
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.undefined));
        source = created ?? (yield* findByName(name));
        if (source === undefined)
          return yield* new FileIngestSourceNotResolved({ sourceName: name });
        return toAttributes(source);
      }

      // Sync: name and description against Galaxy; write-only credentials
      // against the last deploy, and always on adoption.
      const delta = changedFields(
        { ...source, description: source.description ?? "" },
        { name, description: news.description ?? "" },
      );
      const credentialsChanged =
        olds === undefined ||
        !deepEqual(comparable(olds.credentials), comparable(news.credentials));
      if (hasChanges(delta) || credentialsChanged) {
        yield* session.note(`Updating file ingest source ${name}...`);
        yield* galaxy.fileIngestSource.updateFileIngestSource({
          ...delta,
          ...(credentialsChanged
            ? { cloudStorageCredentials: credentialsOf(news.credentials) }
            : {}),
          fileIngestSourceId: source.fileIngestSourceId,
        });
        // The update answers with no body: read the source back.
        source = yield* galaxy.fileIngestSource.getFileIngestSource({
          fileIngestSourceId: source.fileIngestSourceId,
        });
      }
      return toAttributes(source);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* galaxy.fileIngestSource
        .deleteFileIngestSource({ fileIngestSourceId: output.fileIngestSourceId })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),

    list: () =>
      collectAll(
        galaxy.fileIngestSource.listFileIngestSources
          .items({})
          .pipe(Stream.filter((source) => isGeneratedName(source.name))),
        toAttributes,
      ),
  });
