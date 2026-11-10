import * as insights from "@distilled.cloud/gcp/storageinsights_v1";
import { Unowned } from "alchemy/AdoptPolicy";
import { deepEqual, isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { tagRecord } from "alchemy/Tags";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";

export type ReportConfigProps = {
  /** Location of both buckets. Changing it replaces the configuration.
   * @default the stack's GCP region
   */
  location?: string;
  /** User-provided display name, at most 256 characters. */
  displayName?: string;
  /** User labels. Alchemy ownership labels are added automatically. */
  labels?: Record<string, string>;
  /** Daily or weekly schedule, with UTC start and end dates. */
  frequencyOptions: insights.FrequencyOptions;
  /** Source bucket, destination bucket/path, and object metadata fields.
   * Changing storageFilters.bucket replaces the configuration. Metadata
   * fields must include project, bucket, and name.
   */
  objectMetadataReportOptions: insights.ObjectMetadataReportOptions;
} & (
  | {
      /** CSV report options. Mutually exclusive with parquetOptions. */
      csvOptions: insights.CSVOptions;
      /** Parquet report options. Mutually exclusive with csvOptions. */
      parquetOptions?: never;
    }
  | {
      /** CSV report options. Mutually exclusive with parquetOptions. */
      csvOptions?: never;
      /** Use an empty object to generate Parquet reports. */
      parquetOptions: insights.ParquetOptions;
    }
);

export type ReportConfig = Resource<
  "GCP.StorageInsights.ReportConfig",
  ReportConfigProps,
  {
    /** Full server-assigned resource name. */
    name: string;
    /** Server-assigned UUID. */
    reportConfigId: string;
    /** Project owning the configuration. */
    project: string;
    /** Location of the configuration and buckets. */
    location: string;
    /** User-provided display name. */
    displayName: string | undefined;
    /** User labels without Alchemy ownership labels. */
    labels: Record<string, string>;
    /** Inventory report schedule. */
    frequencyOptions: insights.FrequencyOptions | undefined;
    /** Object metadata fields, source, and destination. */
    objectMetadataReportOptions: insights.ObjectMetadataReportOptions | undefined;
    /** CSV options when the report uses CSV. */
    csvOptions: insights.CSVOptions | undefined;
    /** Parquet options when the report uses Parquet. */
    parquetOptions: insights.ParquetOptions | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A scheduled Cloud Storage object inventory report configuration.
 *
 * The API assigns the UUID. Alchemy recovers configurations by ownership
 * labels if local state is lost. Schedule, format, destination, metadata
 * fields, display name, and labels update in place; location or source bucket changes replace
 * the configuration. Deletion removes report details but preserves exported
 * objects in the destination bucket.
 *
 * Enable storageinsights.googleapis.com before deployment. Grant its service
 * agent roles/storage.insightsCollectorService on the source bucket and
 * roles/storage.objectCreator on the destination. Both buckets must be in
 * the same project and location. This resource does not change bucket IAM.
 *
 * ### Creating an Inventory Report
 * **Example:** Daily Parquet inventory
 * ```typescript
 * const inventory = yield* GCP.StorageInsights.ReportConfig("Inventory", {
 *   location: "us-central1",
 *   frequencyOptions: {
 *     frequency: "DAILY",
 *     startDate: { year: 2030, month: 1, day: 1 },
 *     endDate: { year: 2031, month: 1, day: 1 },
 *   },
 *   parquetOptions: {},
 *   objectMetadataReportOptions: {
 *     metadataFields: ["project", "bucket", "name", "size", "generation"],
 *     storageFilters: { bucket: "source-bucket" },
 *     storageDestinationOptions: {
 *       bucket: "inventory-bucket",
 *       destinationPath: "inventory/",
 *     },
 *   },
 * });
 * ```
 *
 * ### Choosing a Report Format
 * Set exactly one of `parquetOptions` or `csvOptions`. Switching between
 * them updates the configuration in place.
 *
 * **Example:** Weekly CSV inventory with a header row
 * ```typescript
 * const inventory = yield* GCP.StorageInsights.ReportConfig("Inventory", {
 *   frequencyOptions: {
 *     frequency: "WEEKLY",
 *     startDate: { year: 2030, month: 1, day: 1 },
 *     endDate: { year: 2031, month: 1, day: 1 },
 *   },
 *   csvOptions: { delimiter: ",", headerRequired: true },
 *   objectMetadataReportOptions: {
 *     metadataFields: ["project", "bucket", "name", "size"],
 *     storageFilters: { bucket: source.bucketName },
 *     storageDestinationOptions: {
 *       bucket: destination.bucketName,
 *       destinationPath: "inventory/",
 *     },
 *   },
 * });
 * ```
 *
 * @resource
 * @category StorageInsights
 */
export const ReportConfig = Resource<ReportConfig>("GCP.StorageInsights.ReportConfig");

const parentOf = (project: string, location: string) => `projects/${project}/locations/${location}`;

const toAttrs = (config: insights.ReportConfig) => {
  const name = config.name!;
  const [, project, , location, , reportConfigId] = name.split("/");
  return {
    name,
    reportConfigId,
    project,
    location,
    displayName: config.displayName,
    labels: stripInternalLabels(tagRecord(config.labels)),
    frequencyOptions: config.frequencyOptions,
    objectMetadataReportOptions: config.objectMetadataReportOptions,
    csvOptions: config.csvOptions,
    parquetOptions: config.parquetOptions,
    createTime: config.createTime,
    updateTime: config.updateTime,
  };
};

const getConfig = (name: string) =>
  insights
    .getProjectsLocationsReportConfigs({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const listConfigs = (parent: string) =>
  insights.listProjectsLocationsReportConfigs.pages({ parent }).pipe(
    Stream.flatMap((page) => Stream.fromIterable(page.reportConfigs ?? [])),
    Stream.runCollect,
  );

const observe = Effect.fn(function* (
  id: string,
  parent: string,
  name?: string,
  sourceBucket?: string,
) {
  if (name !== undefined) {
    const existing = yield* getConfig(name);
    if (existing !== undefined) return existing;
  }
  for (const config of yield* listConfigs(parent)) {
    if (
      sourceBucket !== undefined &&
      config.objectMetadataReportOptions?.storageFilters?.bucket !== sourceBucket
    )
      continue;
    if (yield* hasAlchemyLabels(id, config.labels)) return config;
  }
  return undefined;
});

export const ReportConfigProvider = () =>
  Provider.succeed(ReportConfig, {
    stables: ["name", "reportConfigId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return;
      const env = yield* GcpEnvironment.current;
      const previous = (olds?.location ?? output?.location ?? env.region).toLowerCase();
      const previousSource = (
        olds?.objectMetadataReportOptions ?? output?.objectMetadataReportOptions
      )?.storageFilters?.bucket;
      if (
        (news.location ?? env.region).toLowerCase() !== previous ||
        (previousSource !== undefined &&
          news.objectMetadataReportOptions.storageFilters?.bucket !== previousSource)
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = (olds?.location ?? output?.location ?? env.region).toLowerCase();
      const config = yield* observe(
        id,
        parentOf(env.project, location),
        output?.name,
        olds?.objectMetadataReportOptions.storageFilters?.bucket,
      );
      if (config === undefined) return undefined;
      const attrs = toAttrs(config);
      return (yield* hasAlchemyLabels(id, config.labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        // ReportConfig listing requires a concrete location. Enumerate the
        // service locations so discovery also finds non-default regions.
        const locations = yield* insights.listProjectsLocations
          .pages({ name: `projects/${env.project}` })
          .pipe(
            Stream.flatMap((page) => Stream.fromIterable(page.locations ?? [])),
            Stream.runCollect,
          );
        const configs = (yield* Effect.forEach(
          locations,
          (location) => listConfigs(location.name!),
          { concurrency: 4 },
        )).flat();
        return configs
          .filter(
            (config) =>
              config.labels?.["alchemy-stack"] &&
              config.labels?.["alchemy-stage"] &&
              config.labels?.["alchemy-id"],
          )
          .map(toAttrs);
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = (news.location ?? env.region).toLowerCase();
      const parent = parentOf(env.project, location);
      const labels = { ...toLabels(news.labels), ...(yield* createInternalLabels(id)) };
      const desired: insights.ReportConfig = {
        displayName: news.displayName ?? "",
        labels,
        frequencyOptions: news.frequencyOptions,
        objectMetadataReportOptions: news.objectMetadataReportOptions,
        csvOptions:
          news.csvOptions === undefined
            ? undefined
            : {
                delimiter: ",",
                recordSeparator: "\n",
                headerRequired: false,
                ...news.csvOptions,
              },
        parquetOptions: news.parquetOptions,
      };
      let current = yield* observe(
        id,
        parent,
        output?.name,
        news.objectMetadataReportOptions.storageFilters?.bucket,
      );
      if (current === undefined) {
        const random = yield* SecureRandom.SecureRandom;
        current = yield* insights.createProjectsLocationsReportConfigs({
          parent,
          requestId: yield* random.uuidV4(),
          body: desired,
        });
      }

      // Patch only changed fields; include the previous format in the mask
      // when switching the API's CSV/Parquet oneof to clear it.
      const fields = [
        ["displayName", "display_name"],
        ["labels", "labels"],
        ["frequencyOptions", "frequency_options"],
        ["csvOptions", "csv_options"],
        ["parquetOptions", "parquet_options"],
      ] as const;
      // The API omits an empty display name; compare it as "" so an unset
      // name doesn't patch on every reconcile.
      const observed = { ...current, displayName: current.displayName ?? "" };
      const changed: string[] = fields
        .filter(([key]) => !deepEqual(observed[key], desired[key], { stripNullish: true }))
        .map(([, wireName]) => wireName);
      // The parent metadata mask would include the immutable source bucket.
      // Address only its mutable children when metadata or destination changes.
      const observedMetadata = observed.objectMetadataReportOptions;
      const desiredMetadata = desired.objectMetadataReportOptions;
      if (!deepEqual(observedMetadata?.metadataFields, desiredMetadata?.metadataFields)) {
        changed.push("object_metadata_report_options.metadata_fields");
      }
      if (
        !deepEqual(
          observedMetadata?.storageDestinationOptions,
          desiredMetadata?.storageDestinationOptions,
          { stripNullish: true },
        )
      ) {
        changed.push("object_metadata_report_options.storage_destination_options");
      }
      const updateMask = changed.join(",");
      if (updateMask.length > 0) {
        current = yield* insights.patchProjectsLocationsReportConfigs({
          name: current.name!,
          updateMask,
          body: desired,
        });
      }
      return toAttrs(current);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* insights
        .deleteProjectsLocationsReportConfigs({ name: output.name, force: true })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
