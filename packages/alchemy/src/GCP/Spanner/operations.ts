import * as spanner from "@distilled.cloud/gcp/spanner_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import { ALCHEMY_LABEL_PREFIX } from "../Labels.ts";

export const DEFAULT_CONFIG_ID = "regional-us-central1";
export const DEFAULT_PROCESSING_UNITS = 100;
export const DEFAULT_PARTITION_PROCESSING_UNITS = 1000;
export const MAX_INSTANCE_ID_LENGTH = 64;
export const MAX_INSTANCE_CONFIG_ID_LENGTH = 64;
export const MAX_BACKUP_ID_LENGTH = 60;
export const MAX_BACKUP_SCHEDULE_ID_LENGTH = 60;
export const MAX_PARTITION_ID_LENGTH = 64;
export const MAX_DISPLAY_NAME_LENGTH = 30;
export const MIN_DISPLAY_NAME_LENGTH = 4;
export const CUSTOM_CONFIG_PREFIX = "custom-";

export class OperationFailed extends Data.TaggedError(
  "GCP.Spanner.OperationFailed",
)<{
  operation: string;
  message: string;
}> {}

export class OperationPending extends Data.TaggedError(
  "GCP.Spanner.OperationPending",
)<{
  operation: string;
}> {}

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const parseResourceName = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const after = (segment: string) => {
    const at = parts.lastIndexOf(segment);
    return at >= 0 && parts[at + 1] ? parts[at + 1]! : "";
  };
  const project = after("projects");
  const instanceId = after("instances");
  const databaseId = after("databases");
  return {
    project,
    instanceId,
    databaseId,
    backupId: after("backups"),
    backupScheduleId: after("backupSchedules"),
    instancePartitionId: after("instancePartitions"),
    instanceConfigId: after("instanceConfigs"),
    instance:
      project && instanceId
        ? `projects/${project}/instances/${instanceId}`
        : "",
    database:
      project && instanceId && databaseId
        ? `projects/${project}/instances/${instanceId}/databases/${databaseId}`
        : "",
  };
};

export const instanceIdOf = (value: string) =>
  value.includes("/instances/")
    ? parseResourceName(value).instanceId
    : lastSegment(value);

export const databaseIdOf = (value: string) =>
  value.includes("/databases/")
    ? parseResourceName(value).databaseId
    : lastSegment(value);

export const configIdOf = (config: string | undefined) =>
  lastSegment(config ?? DEFAULT_CONFIG_ID).toLowerCase();

export const instanceName = (project: string, instanceId: string) =>
  `projects/${project}/instances/${instanceId}`;

export const instanceNameOf = (project: string, instance: string) =>
  instance.includes("/instances/")
    ? instanceName(
        parseResourceName(instance).project || project,
        parseResourceName(instance).instanceId,
      )
    : instanceName(project, lastSegment(instance));

export const databaseName = (
  project: string,
  instanceId: string,
  databaseId: string,
) => `${instanceName(project, instanceId)}/databases/${databaseId}`;

export const databaseNameOf = (
  project: string,
  instance: string,
  database: string,
) => {
  if (database.includes("/databases/")) {
    const parsed = parseResourceName(database);
    return databaseName(
      parsed.project || project,
      parsed.instanceId || instanceIdOf(instance),
      parsed.databaseId,
    );
  }
  return databaseName(project, instanceIdOf(instance), lastSegment(database));
};

export const backupName = (
  project: string,
  instanceId: string,
  backupId: string,
) => `${instanceName(project, instanceId)}/backups/${backupId}`;

export const backupScheduleName = (
  project: string,
  instanceId: string,
  databaseId: string,
  scheduleId: string,
) =>
  `${databaseName(project, instanceId, databaseId)}/backupSchedules/${scheduleId}`;

export const instanceConfigName = (project: string, configId: string) =>
  `projects/${project}/instanceConfigs/${configId}`;

export const configNameOf = (project: string, config: string | undefined) => {
  const raw = (config ?? DEFAULT_CONFIG_ID).trim();
  if (raw.includes("/")) return raw;
  return instanceConfigName(project, raw);
};

export const instancePartitionName = (
  project: string,
  instanceId: string,
  partitionId: string,
) => `${instanceName(project, instanceId)}/instancePartitions/${partitionId}`;

export const toSpannerId = (name: string, maxLength: number) => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-");
  next = next.replace(/^-+/, "").replace(/-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `s${next}`;
  next = next.slice(0, maxLength).replace(/-+$/g, "");
  if (next.length < 2) next = `${next}xx`.slice(0, maxLength);
  return next;
};

export const toCustomConfigId = (name: string) => {
  const maxBody = MAX_INSTANCE_CONFIG_ID_LENGTH - CUSTOM_CONFIG_PREFIX.length;
  const body = toSpannerId(name, maxBody);
  if (body.startsWith(CUSTOM_CONFIG_PREFIX)) {
    return body.slice(0, MAX_INSTANCE_CONFIG_ID_LENGTH);
  }
  let next = `${CUSTOM_CONFIG_PREFIX}${body}`;
  next = next.slice(0, MAX_INSTANCE_CONFIG_ID_LENGTH).replace(/-+$/g, "");
  if (!/[a-z0-9]$/.test(next)) {
    next = `${next.slice(0, MAX_INSTANCE_CONFIG_ID_LENGTH - 1)}x`;
  }
  return next;
};

export const toPhysicalId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
  maxLength: number,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return explicit;
    if (existing !== undefined) return existing;
    return toSpannerId(
      yield* createPhysicalName({
        id,
        maxLength,
        lowercase: true,
      }),
      maxLength,
    );
  });

export const toConfigId = (
  id: string,
  explicit: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) {
      return explicit.startsWith(CUSTOM_CONFIG_PREFIX)
        ? explicit
        : toCustomConfigId(explicit);
    }
    if (existing !== undefined) return existing;
    return toCustomConfigId(
      yield* createPhysicalName({
        id,
        maxLength: MAX_INSTANCE_CONFIG_ID_LENGTH,
        lowercase: true,
      }),
    );
  });

export const displayNameOf = (sourceId: string, displayName?: string) => {
  const source = (displayName ?? sourceId).trim();
  let next = source.slice(0, MAX_DISPLAY_NAME_LENGTH);
  if (next.length < MIN_DISPLAY_NAME_LENGTH) {
    next = `${next}inst`.slice(0, MAX_DISPLAY_NAME_LENGTH);
  }
  return next;
};

export const normalizeEnum = (value: string | undefined, fallback: string) => {
  const next = (value ?? fallback).toUpperCase();
  return next.endsWith("_UNSPECIFIED") ? fallback : next;
};

export const hasAlchemyPrefix = (
  labels: Record<string, string | undefined> | null | undefined,
) =>
  Object.keys(labels ?? {}).some((key) => key.startsWith(ALCHEMY_LABEL_PREFIX));

export const isAlreadyExists = (error: spanner.Status | undefined) =>
  error?.code === 6 ||
  (error?.message ?? "").includes("ALREADY_EXISTS") ||
  (error?.message ?? "").toLowerCase().includes("already exists");

export const isNotFoundStatus = (error: spanner.Status | undefined) => {
  if (error === undefined) return false;
  if (error.code === 5) return true;
  return (error.message ?? "").toLowerCase().includes("not found");
};

const getOperation = (name: string) => {
  if (name.includes("/instanceConfigs/")) {
    return spanner.getProjectsInstanceConfigsOperations({ name });
  }
  if (name.includes("/instancePartitions/")) {
    return spanner.getProjectsInstancesInstancePartitionsOperations({ name });
  }
  if (name.includes("/backups/")) {
    return spanner.getProjectsInstancesBackupsOperations({ name });
  }
  if (name.includes("/databases/")) {
    return spanner.getProjectsInstancesDatabasesOperations({ name });
  }
  return spanner.getProjectsInstancesOperations({ name });
};

export const waitForOperation = (
  operation: spanner.Operation,
  options?: { notFoundOk?: boolean; alreadyExistsOk?: boolean },
) =>
  Effect.gen(function* () {
    const name = operation.name;
    if (operation.done === true) {
      if (operation.error) {
        if (
          options?.alreadyExistsOk === true &&
          isAlreadyExists(operation.error)
        ) {
          return operation;
        }
        if (options?.notFoundOk === true && isNotFoundStatus(operation.error)) {
          return operation;
        }
        return yield* new OperationFailed({
          operation: name ?? "",
          message: operation.error.message ?? "operation failed",
        });
      }
      return operation;
    }
    if (name === undefined || name.length === 0) {
      return yield* new OperationFailed({
        operation: "",
        message: "operation is missing a name",
      });
    }

    const resolved =
      options?.notFoundOk === true
        ? getOperation(name).pipe(
            Effect.catchTag("NotFound", () =>
              Effect.succeed({
                name,
                done: true,
              } satisfies spanner.Operation),
            ),
          )
        : getOperation(name).pipe(
            Effect.retry({
              while: (error) => error._tag === "NotFound",
              times: 5,
              schedule: Schedule.exponential("250 millis"),
            }),
          );

    return yield* resolved.pipe(
      Effect.filterOrFail(
        (current) => current.done === true,
        () => new OperationPending({ operation: name }),
      ),
      Effect.flatMap((current) => {
        const status = current.error;
        if (status) {
          if (options?.alreadyExistsOk === true && isAlreadyExists(status)) {
            return Effect.succeed(current);
          }
          if (options?.notFoundOk === true && isNotFoundStatus(status)) {
            return Effect.succeed(current);
          }
          return Effect.fail(
            new OperationFailed({
              operation: name,
              message: status.message ?? "operation failed",
            }),
          );
        }
        return Effect.succeed(current);
      }),
      Effect.retry({
        while: (error) => error._tag === "GCP.Spanner.OperationPending",
        times: 10,
        schedule: Schedule.spaced("8 seconds"),
      }),
    );
  });

export const retryConcurrentChanges = <
  A,
  E extends { readonly _tag: string },
  R,
>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: (error) => error._tag === "Conflict",
      times: 8,
      schedule: Schedule.spaced("5 seconds"),
    }),
  );

export const getInstanceByName = (name: string) =>
  spanner
    .getProjectsInstances({ name })
    .pipe(
      Effect.catchTag(["NotFound", "Forbidden"], () =>
        Effect.succeed(undefined),
      ),
    );

export const listAlchemyInstances = (project: string) =>
  spanner.listProjectsInstances
    .pages({
      parent: `projects/${project}`,
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.instances ?? [])),
      Stream.filter((instance) => hasAlchemyPrefix(instance.labels)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag(["NotFound", "Forbidden"], () =>
        Effect.succeed([] as spanner.Instance[]),
      ),
    );

export const listAlchemyDatabases = (project: string) =>
  Effect.gen(function* () {
    const instances = yield* listAlchemyInstances(project);
    const pages = yield* Effect.forEach(
      instances,
      (instance) => {
        const parent = instance.name;
        if (parent === undefined || parent.length === 0) {
          return Effect.succeed([] as spanner.Database[]);
        }
        return spanner.listProjectsInstancesDatabases
          .pages({
            parent,
            pageSize: 1000,
          })
          .pipe(
            Stream.flatMap((page) => Stream.fromIterable(page.databases ?? [])),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag(["NotFound", "Forbidden"], () =>
              Effect.succeed([] as spanner.Database[]),
            ),
          );
      },
      { concurrency: 4 },
    );
    return pages.flat();
  });

export const parentOwned = (instanceNameValue: string) =>
  getInstanceByName(instanceNameValue).pipe(
    Effect.map((instance) =>
      instance === undefined ? true : hasAlchemyPrefix(instance.labels),
    ),
  );
