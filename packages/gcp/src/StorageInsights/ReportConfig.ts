import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as insights from "@distilled.cloud/gcp/storageinsights_v1";
import * as serviceusage from "@distilled.cloud/gcp/unstable/serviceusage_v1beta1";
import { Unowned } from "alchemy/AdoptPolicy";
import { deepEqual, isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { tagRecord } from "alchemy/Tags";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { GcpEnvironment } from "../Environment.ts";
import { revokeIamMembership, updateIamMembership } from "../IamPolicy.ts";
import {
  createInternalLabels,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import { waitForOperation } from "../Operation.ts";
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
 * Enable storageinsights.googleapis.com before deployment. Both buckets
 * must be in the same project and location. Alchemy grants the Storage
 * Insights service agent `roles/storage.insightsCollectorService` on the
 * source bucket and `roles/storage.objectCreator` on the destination, and
 * revokes each role when the configuration is deleted or its destination
 * moves. A role stays while another inventory configuration in the location
 * still uses that bucket, since every configuration in the project shares
 * the agent.
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

const configsOf = (parent: string) =>
  insights.listProjectsLocationsReportConfigs
    .pages({ parent })
    .pipe(Stream.flatMap((page) => Stream.fromIterable(page.reportConfigs ?? [])));

const listConfigs = (parent: string) => configsOf(parent).pipe(Stream.runCollect);

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
  const found = yield* configsOf(parent).pipe(
    Stream.filter(
      (config) =>
        sourceBucket === undefined ||
        config.objectMetadataReportOptions?.storageFilters?.bucket === sourceBucket,
    ),
    Stream.filterEffect((config) => hasAlchemyLabels(id, config.labels)),
    Stream.runHead,
  );
  return Option.getOrUndefined(found);
});

const COLLECTOR_ROLE = "roles/storage.insightsCollectorService";
const CREATOR_ROLE = "roles/storage.objectCreator";

/**
 * Storage Insights checks the service agent's bucket permissions on create
 * and on a destination change. A role granted moments earlier can take a
 * few seconds to reach it, surfaced as `Forbidden`.
 */
const retryGrantPropagation = <A, E extends { _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.retry({
      while: (error) => error._tag === "Forbidden",
      times: 10,
      schedule: Schedule.spaced("3 seconds"),
    }),
  );

const serviceAgentOf = Effect.fn(function* (project: string) {
  const resource = yield* resourcemanager.getProjects({ name: `projects/${project}` });
  const projectNumber = resource.name!.split("/")[1];
  return {
    projectNumber,
    member: `serviceAccount:service-${projectNumber}@gcp-sa-storageinsights.iam.gserviceaccount.com`,
  };
});

/**
 * Google creates the Storage Insights service agent
 * (`service-{number}@gcp-sa-storageinsights…`) lazily; granting it a role
 * before it exists fails. Generating the identity is idempotent.
 */
const ensureServiceAgent = Effect.fn(function* (project: string) {
  const { projectNumber, member } = yield* serviceAgentOf(project);
  const operation = yield* serviceusage
    .generateServiceIdentityServices({
      parent: `projects/${projectNumber}/services/storageinsights.googleapis.com`,
    })
    .pipe(Effect.catchTag("Conflict", () => Effect.undefined));
  if (operation !== undefined) {
    yield* waitForOperation(operation, (name) => serviceusage.getOperations({ name }), {
      budget: "2 minutes",
      interval: "2 seconds",
    });
  }
  return member;
});

/**
 * The service agent reads the source bucket and writes reports to the
 * destination.
 */
const grantServiceAgent = Effect.fn(function* (
  project: string,
  options: insights.ObjectMetadataReportOptions,
) {
  const member = yield* ensureServiceAgent(project);
  const source = options.storageFilters?.bucket;
  const destination = options.storageDestinationOptions?.bucket;
  if (source !== undefined) {
    yield* updateIamMembership({
      kind: "storage.bucket",
      name: source,
      member,
      add: [COLLECTOR_ROLE],
    });
  }
  if (destination !== undefined) {
    yield* updateIamMembership({
      kind: "storage.bucket",
      name: destination,
      member,
      add: [CREATOR_ROLE],
    });
  }
});

/**
 * Revoke the service agent's role on a bucket this configuration no longer
 * uses. The agent is shared by every inventory configuration in the project
 * (Alchemy's or not), so a role stays while any other configuration in the
 * location still reads from, or writes to, that bucket. Both buckets must
 * share the configuration's location, so one location's list is complete.
 */
const releaseServiceAgent = Effect.fn(function* (
  project: string,
  parent: string,
  self: string,
  buckets: { source?: string; destination?: string },
) {
  const others = (yield* listConfigs(parent)).filter((config) => config.name !== self);
  const { member } = yield* serviceAgentOf(project);
  const { source, destination } = buckets;
  if (
    source !== undefined &&
    !others.some((config) => config.objectMetadataReportOptions?.storageFilters?.bucket === source)
  ) {
    yield* revokeIamMembership({
      kind: "storage.bucket",
      name: source,
      member,
      roles: [COLLECTOR_ROLE],
    });
  }
  if (
    destination !== undefined &&
    !others.some(
      (config) =>
        config.objectMetadataReportOptions?.storageDestinationOptions?.bucket === destination,
    )
  ) {
    yield* revokeIamMembership({
      kind: "storage.bucket",
      name: destination,
      member,
      roles: [CREATOR_ROLE],
    });
  }
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
      yield* grantServiceAgent(env.project, news.objectMetadataReportOptions);
      let current = yield* observe(
        id,
        parent,
        output?.name,
        news.objectMetadataReportOptions.storageFilters?.bucket,
      );
      if (current === undefined) {
        const random = yield* SecureRandom.SecureRandom;
        const requestId = yield* random.uuidV4();
        current = yield* retryGrantPropagation(
          insights.createProjectsLocationsReportConfigs({ parent, requestId, body: desired }),
        );
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
        current = yield* retryGrantPropagation(
          insights.patchProjectsLocationsReportConfigs({
            name: current.name!,
            updateMask,
            body: desired,
          }),
        );
      }
      // The destination bucket updates in place; release the one it left.
      const previousDestination = observedMetadata?.storageDestinationOptions?.bucket;
      if (
        previousDestination !== undefined &&
        previousDestination !== desiredMetadata?.storageDestinationOptions?.bucket
      ) {
        yield* releaseServiceAgent(env.project, parent, current.name!, {
          destination: previousDestination,
        });
      }
      return toAttrs(current);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* insights
        .deleteProjectsLocationsReportConfigs({ name: output.name, force: true })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* releaseServiceAgent(
        output.project,
        parentOf(output.project, output.location),
        output.name,
        {
          source: output.objectMetadataReportOptions?.storageFilters?.bucket,
          destination: output.objectMetadataReportOptions?.storageDestinationOptions?.bucket,
        },
      );
    }),
  });
