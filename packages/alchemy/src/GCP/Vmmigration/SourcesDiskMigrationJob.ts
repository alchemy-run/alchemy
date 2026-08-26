import * as vm from "@distilled.cloud/gcp/vmmigration_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  collectPages,
  fieldMask,
  fingerprint,
  forEachSource,
  hasAlchemyLabelMap,
  normalizeLocation,
  parseName,
  replaceOnIdentity,
  ResourceNotResolved,
  sourceOf,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

export type DiskMigrationJobTargetDetails = vm.DiskMigrationJobTargetDetails;
export type AwsSourceDiskDetails = vm.AwsSourceDiskDetails;
export type DiskMigrationJobState =
  | vm.DiskMigrationJobStateEnum
  | (string & {});

export type SourcesDiskMigrationJobProps = {
  /**
   * Parent source. Full name
   * `projects/{project}/locations/{location}/sources/{source}` or the
   * source id (combined with `location`). Immutable — changing it
   * replaces the job.
   */
  source: string;
  /**
   * Region used when `source` is a bare id.
   * @default "us-central1"
   */
  location?: string;
  /**
   * Disk migration job id. If omitted, a unique RFC1035 name is
   * generated. Immutable — changing it replaces the job.
   */
  diskMigrationJobId?: string;
  /**
   * Target disk in Compute Engine. Alchemy ownership labels are merged
   * into `targetDetails.labels` (the job itself has no labels field).
   */
  targetDetails: DiskMigrationJobTargetDetails;
  /**
   * Unattached AWS source disk. Immutable volume id — changing it
   * replaces the job.
   */
  awsSourceDiskDetails?: AwsSourceDiskDetails;
};

export type SourcesDiskMigrationJob = Resource<
  "GCP.Vmmigration.SourcesDiskMigrationJob",
  SourcesDiskMigrationJobProps,
  {
    /** Full resource name. */
    name: string;
    /** Disk migration job id (last path segment). */
    diskMigrationJobId: string;
    /** Parent source resource name. */
    source: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Target disk details with Alchemy labels stripped. */
    targetDetails: DiskMigrationJobTargetDetails | undefined;
    /** AWS source disk details. */
    awsSourceDiskDetails: AwsSourceDiskDetails | undefined;
    /** Job state. */
    state: string | undefined;
    /** Progress steps. */
    steps: vm.DiskMigrationStepList | undefined;
    /** Errors that led to a failed state. */
    errors: vm.StatusList | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A VM Migration disk migration job that copies an unattached source
 * disk into a Compute Engine persistent disk.
 *
 * The job has no labels field — Alchemy stamps ownership into
 * `targetDetails.labels` so `list` / nuke can find them. Source, job
 * id, and AWS volume id are immutable. Target details update in place.
 *
 * ### Creating a Disk Migration Job
 * **Example:** AWS volume to Compute Engine
 * ```typescript
 * const job = yield* GCP.Vmmigration.SourcesDiskMigrationJob("Boot", {
 *   source: source.name,
 *   awsSourceDiskDetails: { volumeId: "vol-123" },
 *   targetDetails: {
 *     targetProject: target.name,
 *     targetDisk: {
 *       zone: "projects/my-project/locations/us-central1-a",
 *       diskType: "COMPUTE_ENGINE_DISK_TYPE_STANDARD",
 *       diskId: "imported-boot",
 *     },
 *   },
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Vmmigration
 */
export const SourcesDiskMigrationJob = Resource<SourcesDiskMigrationJob>(
  "GCP.Vmmigration.SourcesDiskMigrationJob",
);

const resourceName = (source: string, diskMigrationJobId: string) =>
  `${source}/diskMigrationJobs/${diskMigrationJobId}`;

const stampTarget = (
  target: DiskMigrationJobTargetDetails,
  ownership: Record<string, string>,
): DiskMigrationJobTargetDetails => ({
  ...target,
  labels: {
    ...toLabels(tagRecord(target.labels)),
    ...ownership,
  },
});

const stripTarget = (
  target: DiskMigrationJobTargetDetails | undefined,
): DiskMigrationJobTargetDetails | undefined => {
  if (target === undefined) return undefined;
  return {
    ...target,
    labels: userLabels(target.labels),
  };
};

const toAttrs = (job: vm.DiskMigrationJob, project: string) => {
  const name = job.name ?? "";
  const parsed = parseName(name, "diskMigrationJobs");
  return {
    name,
    diskMigrationJobId: parsed.id,
    source: parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    targetDetails: stripTarget(job.targetDetails),
    awsSourceDiskDetails: job.awsSourceDiskDetails,
    state: job.state,
    steps: job.steps,
    errors: job.errors,
    createTime: job.createTime,
    updateTime: job.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : vm
        .getProjectsLocationsSourcesDiskMigrationJobs({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listChildren = (parent: string) =>
  collectPages(
    vm.listProjectsLocationsSourcesDiskMigrationJobs.pages({
      parent,
      pageSize: 1000,
    }),
    (page) => page.diskMigrationJobs,
  ).pipe(
    Effect.catchTag(["NotFound", "Forbidden"], () =>
      Effect.succeed([] as vm.DiskMigrationJob[]),
    ),
  );

export const SourcesDiskMigrationJobProvider = () =>
  Provider.succeed(SourcesDiskMigrationJob, {
    stables: [
      "name",
      "diskMigrationJobId",
      "source",
      "project",
      "location",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousVolume =
        olds?.awsSourceDiskDetails?.volumeId ??
        output?.awsSourceDiskDetails?.volumeId;
      const nextVolume = news.awsSourceDiskDetails?.volumeId ?? previousVolume;
      const previousSource = olds?.source ?? output?.source;
      return replaceOnIdentity({
        previousId: olds?.diskMigrationJobId ?? output?.diskMigrationJobId,
        nextId:
          news.diskMigrationJobId ??
          olds?.diskMigrationJobId ??
          output?.diskMigrationJobId,
        previousLocation: normalizeLocation(olds?.location ?? output?.location),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
        ),
        previousParent: previousSource,
        nextParent: news.source ?? previousSource,
        extra: previousVolume !== nextVolume,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(olds?.location ?? output?.location);
      const diskMigrationJobId = yield* toPhysicalId(
        id,
        olds?.diskMigrationJobId,
        output?.diskMigrationJobId,
        "diskmigration",
      );
      const source =
        olds?.source !== undefined
          ? sourceOf(olds.source, env.project, location)
          : (output?.source ?? "");
      const name =
        output?.name ??
        (source.length > 0 ? resourceName(source, diskMigrationJobId) : "");
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(
        id,
        tagRecord(existing.targetDetails?.labels),
      ))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* forEachSource(env.project, listChildren);
        return items
          .filter((item) => hasAlchemyLabelMap(item.targetDetails?.labels))
          .map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(news.location ?? output?.location);
      const source = sourceOf(news.source, env.project, location);
      const diskMigrationJobId = yield* toPhysicalId(
        id,
        news.diskMigrationJobId,
        output?.diskMigrationJobId,
        "diskmigration",
      );
      const name = resourceName(source, diskMigrationJobId);
      const ownership = yield* createInternalLabels(id);
      const targetDetails = stampTarget(news.targetDetails, ownership);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* vm
          .createProjectsLocationsSourcesDiskMigrationJobs({
            parent: source,
            diskMigrationJobId,
            body: {
              targetDetails,
              awsSourceDiskDetails: news.awsSourceDiskDetails,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(getByName(name), name);
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      const observedLabels = tagRecord(current.targetDetails?.labels);
      const desiredLabels = tagRecord(targetDetails.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const targetChanged =
        fingerprint({
          ...current.targetDetails,
          labels: undefined,
        }) !==
        fingerprint({
          ...targetDetails,
          labels: undefined,
        });
      const mask = fieldMask([
        (labelsChanged || targetChanged) && "targetDetails",
      ]);

      if (mask.length > 0) {
        const operation =
          yield* vm.patchProjectsLocationsSourcesDiskMigrationJobs({
            name: current.name ?? name,
            updateMask: mask,
            body: {
              name: current.name ?? name,
              targetDetails,
            },
          });
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* vm
        .deleteProjectsLocationsSourcesDiskMigrationJobs({
          name: output.name,
        })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
