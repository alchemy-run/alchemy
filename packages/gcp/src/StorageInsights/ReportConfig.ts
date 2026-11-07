import * as storageinsights from "@distilled.cloud/gcp/storageinsights_v1";
import * as serviceusage from "@distilled.cloud/gcp/unstable/serviceusage_v1beta1";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { tagRecord } from "alchemy/Tags";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { GcpEnvironment } from "../Environment.ts";
import { updateIamMembership } from "../IamPolicy.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import { waitForOperation } from "../Operation.ts";
import type { Providers } from "../Providers.ts";
import { projectNumberOf } from "../ResourceManager/internal.ts";

const DEFAULT_METADATA_FIELDS = ["project", "bucket", "name", "size", "updated", "storageClass"];

export type ReportConfigProps = {
  /**
   * Location of the config: the source bucket's region or multi-region.
   * Immutable — changing it replaces the config.
   * @default the stack's GCP region
   */
  location?: string;
  /** Display name. */
  displayName?: string;
  /** Bucket whose objects are reported. */
  sourceBucket: string;
  /** Bucket the reports are written to. */
  destinationBucket: string;
  /** Path inside the destination bucket, which may use `{{date}}` and `{{time}}`. */
  destinationPath?: string;
  /**
   * Object metadata each report row carries.
   * @default ["project", "bucket", "name", "size", "updated", "storageClass"]
   */
  metadataFields?: string[];
  /**
   * How often a report is generated.
   * @default "DAILY"
   */
  frequency?: "DAILY" | "WEEKLY";
  /** First day a report is generated, as `YYYY-MM-DD`. */
  startDate: string;
  /** Last day a report is generated, as `YYYY-MM-DD`. */
  endDate: string;
  /**
   * File format of the reports.
   * @default "csv"
   */
  format?: "csv" | "parquet";
  /** User labels. Alchemy ownership labels are merged in automatically. */
  labels?: Record<string, string>;
};

export type ReportConfig = Resource<
  "GCP.StorageInsights.ReportConfig",
  ReportConfigProps,
  {
    /** Full name `projects/{project}/locations/{location}/reportConfigs/{id}`. */
    name: string;
    /** Server-assigned config id. */
    reportConfigId: string;
    /** Project id. */
    project: string;
    /** Location. */
    location: string;
    /** Display name. */
    displayName: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** When the config was created. */
    createTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Storage Insights inventory report config: a daily or weekly CSV or
 * Parquet listing of a bucket's objects, written to another bucket.
 *
 * The provider grants the project's Storage Insights service agent
 * `roles/storage.insightsCollectorService` on the source bucket and
 * `roles/storage.objectCreator` on the destination bucket. The grants stay
 * when the config is deleted, since other configs may share them.
 *
 * ### Reporting a Bucket's Inventory
 * **Example:** A daily CSV inventory
 * ```typescript
 * const data = yield* GCP.Storage.Bucket("Data", { location: "US-CENTRAL1" });
 * const reports = yield* GCP.Storage.Bucket("Reports", { location: "US-CENTRAL1" });
 * yield* GCP.StorageInsights.ReportConfig("Inventory", {
 *   location: "us-central1",
 *   sourceBucket: data.bucketName,
 *   destinationBucket: reports.bucketName,
 *   destinationPath: "inventory/{{date}}",
 *   startDate: "2026-12-01",
 *   endDate: "2027-12-01",
 * });
 * ```
 *
 * @resource
 * @category Storage Insights
 */
export const ReportConfig = Resource<ReportConfig>("GCP.StorageInsights.ReportConfig");

export class ReportConfigNotResolved extends Data.TaggedError(
  "GCP.StorageInsights.ReportConfigNotResolved",
)<{ location: string }> {}

export class InvalidReportDate extends Data.TaggedError("GCP.StorageInsights.InvalidReportDate")<{
  value: string;
}> {}

const lastSegment = (value: string) => value.replace(/\/+$/, "").split("/").pop() ?? value;

const toDate = (value: string) =>
  Effect.gen(function* () {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (match === null) return yield* new InvalidReportDate({ value });
    return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  });

const fromDate = (date: storageinsights.Storageinsights_Date | undefined) =>
  date?.year === undefined
    ? undefined
    : `${date.year}-${String(date.month ?? 1).padStart(2, "0")}-${String(date.day ?? 1).padStart(2, "0")}`;

const getByName = (name: string) =>
  storageinsights
    .getProjectsLocationsReportConfigs({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const listAt = (parent: string) =>
  storageinsights.listProjectsLocationsReportConfigs.pages({ parent }).pipe(
    Stream.flatMap((page) => Stream.fromIterable(page.reportConfigs ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  );

/** A config's id is server-assigned: find ours by its ownership labels. */
const findOwned = (id: string, parent: string) =>
  Effect.gen(function* () {
    for (const config of yield* listAt(parent)) {
      if (yield* hasAlchemyLabels(id, tagRecord(config.labels))) return config;
    }
    return undefined;
  });

const toAttrs = (
  config: storageinsights.ReportConfig,
  project: string,
): ReportConfig["Attributes"] => {
  const name = config.name ?? "";
  const parts = name.split("/");
  return {
    name,
    reportConfigId: lastSegment(name),
    project: parts[1] ?? project,
    location: parts[3] ?? "",
    displayName: config.displayName,
    labels: stripInternalLabels(tagRecord(config.labels)),
    createTime: config.createTime,
  };
};

const sameJson = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

/** The project's Storage Insights service agent, created on first use. */
const ensureServiceAgent = (project: string) =>
  Effect.gen(function* () {
    const operation = yield* serviceusage
      .generateServiceIdentityServices({
        parent: `projects/${project}/services/storageinsights.googleapis.com`,
      })
      .pipe(Effect.catchTag("Conflict", () => Effect.undefined));
    if (operation !== undefined) {
      yield* waitForOperation(operation, (name) => serviceusage.getOperations({ name }), {
        budget: "2 minutes",
        interval: "2 seconds",
      });
    }
    const number = yield* projectNumberOf(project);
    return `service-${number}@gcp-sa-storageinsights.iam.gserviceaccount.com`;
  });

export const ReportConfigProvider = () =>
  Provider.succeed(ReportConfig, {
    stables: ["name", "reportConfigId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previous = olds?.location ?? output?.location;
      const next = news.location ?? env.region;
      if (previous !== undefined && lastSegment(previous) !== lastSegment(next)) {
        return { action: "replace" as const };
      }
      // The source bucket and format are fixed at create.
      if (
        olds !== undefined &&
        (olds.sourceBucket !== news.sourceBucket ||
          (olds.format ?? "csv") !== (news.format ?? "csv"))
      ) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = lastSegment(output?.location ?? olds?.location ?? env.region);
      const existing = output?.name
        ? yield* getByName(output.name)
        : yield* findOwned(id, `projects/${env.project}/locations/${location}`);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels))) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = lastSegment(news.location ?? output?.location ?? env.region);
      const parent = `projects/${env.project}/locations/${location}`;
      const desiredLabels = { ...toLabels(news.labels), ...(yield* createInternalLabels(id)) };
      const frequencyOptions: storageinsights.FrequencyOptions = {
        frequency: news.frequency ?? "DAILY",
        startDate: yield* toDate(news.startDate),
        endDate: yield* toDate(news.endDate),
      };
      const objectMetadataReportOptions: storageinsights.ObjectMetadataReportOptions = {
        metadataFields: news.metadataFields ?? DEFAULT_METADATA_FIELDS,
        storageFilters: { bucket: news.sourceBucket },
        storageDestinationOptions: {
          bucket: news.destinationBucket,
          destinationPath: news.destinationPath,
        },
      };
      const format =
        (news.format ?? "csv") === "csv"
          ? { csvOptions: { delimiter: ",", recordSeparator: "\n", headerRequired: true } }
          : { parquetOptions: {} };

      // The service agent reads the source bucket and writes the destination.
      const agent = yield* ensureServiceAgent(env.project);
      yield* updateIamMembership({
        kind: "storage.bucket",
        name: news.sourceBucket,
        member: agent,
        add: ["roles/storage.insightsCollectorService"],
      });
      yield* updateIamMembership({
        kind: "storage.bucket",
        name: news.destinationBucket,
        member: agent,
        add: ["roles/storage.objectCreator"],
      });

      // Observe
      let current = output?.name ? yield* getByName(output.name) : yield* findOwned(id, parent);

      // Ensure
      if (current === undefined) {
        current = yield* storageinsights.createProjectsLocationsReportConfigs({
          parent,
          body: {
            displayName: news.displayName,
            labels: desiredLabels,
            frequencyOptions,
            objectMetadataReportOptions,
            ...format,
          },
        });
      }

      // Sync the mutable fields against the live config.
      const { upsert, removed } = diffLabels(tagRecord(current.labels), desiredLabels);
      const mask = [
        (current.displayName ?? "") !== (news.displayName ?? "") && "displayName",
        (upsert.length > 0 || removed.length > 0) && "labels",
        (current.frequencyOptions?.frequency !== frequencyOptions.frequency ||
          fromDate(current.frequencyOptions?.startDate) !== news.startDate ||
          fromDate(current.frequencyOptions?.endDate) !== news.endDate) &&
          "frequencyOptions",
        !sameJson(
          current.objectMetadataReportOptions?.metadataFields,
          objectMetadataReportOptions.metadataFields,
        ) && "objectMetadataReportOptions.metadataFields",
        !sameJson(
          current.objectMetadataReportOptions?.storageDestinationOptions,
          objectMetadataReportOptions.storageDestinationOptions,
        ) && "objectMetadataReportOptions.storageDestinationOptions",
      ].filter((field): field is string => typeof field === "string");
      if (mask.length > 0) {
        current = yield* storageinsights.patchProjectsLocationsReportConfigs({
          name: current.name ?? "",
          updateMask: mask.join(","),
          body: {
            displayName: news.displayName,
            labels: desiredLabels,
            frequencyOptions,
            objectMetadataReportOptions,
          },
        });
      }
      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* storageinsights
        .deleteProjectsLocationsReportConfigs({ name: output.name, force: true })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
