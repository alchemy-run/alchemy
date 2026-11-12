import * as galaxy from "@distilled.cloud/starburst-galaxy";
import type {
  LiveTable as LiveTableShape,
  LiveTableLiveTableState,
  NewTypeProperties,
  TypeProperties,
} from "@distilled.cloud/starburst-galaxy/live_table";
import { Unowned } from "alchemy/AdoptPolicy";
import { deepEqual, isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { findFirst, waitForState } from "../internal.ts";
import type { Providers } from "../Providers.ts";

export interface LiveTableProps {
  /** ID of the lakehouse catalog (S3, GCS) the table lives in. */
  readonly catalogId: string;
  /** Schema of the table; it must exist. */
  readonly schemaName: string;
  /** Table name. */
  readonly tableName: string;
  /**
   * What feeds the table: a Kafka topic (`newKafkaIngestProperties`), files
   * (`newFileIngestProperties`), or a transform of another live table
   * (`newIngestJsonTransformProperties`,
   * `newIngestSchemaRegistryAvroTransformProperties`,
   * `newFilterAndProjectTransformProperties`).
   */
  readonly typeProperties: NewTypeProperties;
  /**
   * `Continue` skips records that fail to load; `FailFast` stops the table.
   * @default "Continue"
   */
  readonly failureMode?: "Continue" | "FailFast";
  /** Days of data to keep; unlimited when unset. */
  readonly dataRetentionDays?: number;
  /** Days of Iceberg snapshots to keep. */
  readonly snapshotRetentionDays?: number;
  /** Description shown in Galaxy. */
  readonly description?: string;
}

export interface LiveTableAttributes {
  /** Galaxy's live table ID. */
  readonly liveTableId: string;
  /** Catalog the table lives in. */
  readonly catalogId: string;
  /** Name of that catalog. */
  readonly catalogName: string;
  /** Schema of the table. */
  readonly schemaName: string;
  /** Table name. */
  readonly tableName: string;
  /** Galaxy cloud region the ingestion runs in. */
  readonly cloudRegionId: string;
  /** `Running`, `Stopping` or `Stopped`. */
  readonly state: LiveTableLiveTableState;
  /** Why the table stopped, if it did. */
  readonly stopMessage: string | undefined;
  /** What feeds the table, as Galaxy reports it. */
  readonly typeProperties: TypeProperties;
}

export type LiveTable = Resource<
  "StarburstGalaxy.Ingest.LiveTable",
  LiveTableProps,
  LiveTableAttributes,
  never,
  Providers
>;

/** The live table stopped instead of running. */
export class LiveTableStopped extends Data.TaggedError("StarburstGalaxy.LiveTableStopped")<{
  readonly liveTableId: string;
  readonly stopType: string | undefined;
  readonly stopMessage: string | undefined;
}> {
  override get message() {
    return `Live table ${this.liveTableId} stopped: ${this.stopMessage ?? this.stopType ?? "no reason given"}`;
  }
}

/** Galaxy accepted a live table create but the table could not be read back. */
export class LiveTableNotResolved extends Data.TaggedError("StarburstGalaxy.LiveTableNotResolved")<{
  readonly tableName: string;
}> {
  override get message() {
    return `Live table ${this.tableName} could not be found after it was created`;
  }
}

/**
 * A Starburst Galaxy live table: a Galaxy-managed Iceberg table that
 * streaming ingestion keeps loading from a Kafka topic or from files in a
 * bucket, or that transforms another live table.
 *
 * Galaxy has no general update for a live table: every prop replaces it
 * (the new table is created after the old one is deleted, since both would
 * hold the same name). `reconcile` returns once Galaxy reports the table
 * `Running`, and fails with `StarburstGalaxy.Ingest.LiveTableStopped` when it
 * stops instead. Ingestion runs continuously and is billed as streaming
 * compute.
 *
 * Live tables have no name of their own: one Alchemy created is
 * recognized by state, and one found without state is `Unowned`.
 *
 * @see https://docs.starburst.io/starburst-galaxy/working-with-data/data-ingest/index.html
 *
 * ### Loading files
 * **Example:** JSON files from a bucket, polled every five minutes
 * ```typescript
 * const lake = StarburstGalaxy.Catalog.S3Catalog.lookup({ name: "lake" });
 * const source = yield* StarburstGalaxy.Ingest.FileIngestSource("Events", {
 *   bucket: "acme-events",
 *   bucketCloudRegionId: "aws-us-east1",
 *   credentials: {
 *     type: "externalIamRole",
 *     roleArn: "arn:aws:iam::123456789012:role/galaxy-ingest",
 *   },
 * });
 * yield* StarburstGalaxy.Ingest.LiveTable("RawEvents", {
 *   catalogId: lake.catalogId,
 *   schemaName: "ingest",
 *   tableName: "raw_events",
 *   typeProperties: {
 *     typeKey: "newFileIngestProperties",
 *     fileIngestSourceId: source.fileIngestSourceId,
 *     fileFormat: "Json",
 *     pollingIntervalInMinutes: 5,
 *   },
 * });
 * ```
 *
 * ### Streaming a Kafka topic
 * **Example:** From the earliest offset
 * ```typescript
 * const lake = StarburstGalaxy.Catalog.S3Catalog.lookup({ name: "lake" });
 * const clicks = yield* StarburstGalaxy.Ingest.KafkaIngestSource("Clicks", {
 *   brokers: ["b-1.clicks.abc123.kafka.us-east-1.amazonaws.com:9098"],
 *   auth: { type: "iam", awsRoleArn: "arn:aws:iam::123456789012:role/galaxy-msk" },
 * });
 * yield* StarburstGalaxy.Ingest.LiveTable("Clicks", {
 *   catalogId: lake.catalogId,
 *   schemaName: "ingest",
 *   tableName: "clicks",
 *   typeProperties: {
 *     typeKey: "newKafkaIngestProperties",
 *     kafkaIngestSourceId: clicks.kafkaIngestSourceId,
 *     kafkaTopicName: "clicks",
 *     startStrategy: "Earliest",
 *     partitionMaxBytesPerSec: 1048576,
 *     latencyMode: "BalancedMode",
 *   },
 * });
 * ```
 *
 * @resource
 * @product Ingest
 */
export const LiveTable = Resource<LiveTable>("StarburstGalaxy.Ingest.LiveTable");

const toAttributes = (table: LiveTableShape): LiveTableAttributes => ({
  liveTableId: table.liveTableId,
  catalogId: table.catalogId,
  catalogName: table.catalogName,
  schemaName: table.schemaName,
  tableName: table.tableName,
  cloudRegionId: table.cloudRegionId,
  state: table.liveTableState,
  stopMessage: table.stopMessage,
  typeProperties: table.typeProperties,
});

const getTable = (liveTableId: string) =>
  galaxy.liveTable
    .getLiveTable({ liveTableId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const findByTable = (props: {
  readonly catalogId: string;
  readonly schemaName: string;
  readonly tableName: string;
}) =>
  findFirst(
    galaxy.liveTable.listLiveTables.items({}),
    (table) =>
      table.catalogId === props.catalogId &&
      table.schemaName === props.schemaName &&
      table.tableName === props.tableName,
  );

/**
 * Wait until Galaxy reports the table `Running`, for up to ten minutes:
 * ingestion starts asynchronously. A table that stops fails the deploy.
 */
const waitForRunning = (liveTableId: string) =>
  waitForState(
    galaxy.liveTable.getLiveTable({ liveTableId }).pipe(
      Effect.filterOrFail(
        (table) => table.liveTableState !== "Stopped",
        (table) =>
          new LiveTableStopped({
            liveTableId,
            stopType: table.stopType,
            stopMessage: table.stopMessage,
          }),
      ),
    ),
    {
      waitingFor: `live table ${liveTableId} to run`,
      done: (table): table is LiveTableShape => table.liveTableState === "Running",
      stateOf: (table) => table.liveTableState,
      interval: "5 seconds",
      budget: "10 minutes",
    },
  );

export const LiveTableProvider = () =>
  Provider.succeed(LiveTable, {
    stables: ["liveTableId", "catalogId", "schemaName", "tableName", "cloudRegionId"],

    nuke: {
      // A live table holds its catalog and its source.
      dependsOn: [
        "StarburstGalaxy.Catalog.*",
        "StarburstGalaxy.Ingest.FileIngestSource",
        "StarburstGalaxy.Ingest.KafkaIngestSource",
      ],
    },

    diff: Effect.fn(function* ({ news, olds }) {
      if (!isResolved(news)) return undefined;
      // No update operation: any change is a new table under the same name.
      if (!deepEqual(news, olds)) return { action: "replace", deleteFirst: true } as const;
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const table =
        output !== undefined ? yield* getTable(output.liveTableId) : yield* findByTable(olds);
      if (table === undefined) return undefined;
      const attributes = toAttributes(table);
      return output !== undefined ? attributes : Unowned(attributes);
    }),

    reconcile: Effect.fn(function* ({ news, output, session }) {
      // Observe
      const existing =
        output !== undefined ? yield* getTable(output.liveTableId) : yield* findByTable(news);

      // Ensure: a create carries the whole desired state.
      let liveTableId = existing?.liveTableId;
      if (liveTableId === undefined) {
        yield* session.note(`Creating live table ${news.schemaName}.${news.tableName}...`);
        const created = yield* galaxy.liveTable
          .createLiveTable({
            catalogId: news.catalogId,
            schemaName: news.schemaName,
            tableName: news.tableName,
            typeProperties: news.typeProperties,
            failureMode: news.failureMode ?? "Continue",
            dataRetentionDays: news.dataRetentionDays,
            snapshotRetentionDays: news.snapshotRetentionDays,
            description: news.description,
          })
          .pipe(Effect.catchTag("Conflict", () => findByTable(news)));
        liveTableId = created?.liveTableId;
      }
      if (liveTableId === undefined) {
        return yield* new LiveTableNotResolved({
          tableName: `${news.schemaName}.${news.tableName}`,
        });
      }

      // Wait: ingestion starts asynchronously.
      yield* session.note(`Waiting for live table ${news.tableName} to run...`);
      return toAttributes(yield* waitForRunning(liveTableId));
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* galaxy.liveTable
        .deleteLiveTable({ liveTableId: output.liveTableId })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),

    // Live tables have no name of their own to mark them as Alchemy's.
    list: () => Effect.succeed([]),
  });
