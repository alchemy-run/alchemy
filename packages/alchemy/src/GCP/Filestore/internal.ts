import * as file from "@distilled.cloud/gcp/file_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import { tagRecord } from "../../Tags.ts";
import { stripInternalLabels } from "../Labels.ts";

export const DEFAULT_ZONE = "us-central1-a";
export const DEFAULT_REGION = "us-central1";
export const DEFAULT_SHARE_NAME = "share1";
export const MAX_NAME_LENGTH = 63;

export class FilestoreOperationFailed extends Data.TaggedError(
  "GCP.Filestore.OperationFailed",
)<{
  operation: string;
  message: string;
}> {}

export class FilestoreOperationPending extends Data.TaggedError(
  "GCP.Filestore.OperationPending",
)<{
  operation: string;
}> {}

export class ResourceNotResolved extends Data.TaggedError(
  "GCP.Filestore.ResourceNotResolved",
)<{
  name: string;
}> {}

export class ResourceStillExists extends Data.TaggedError(
  "GCP.Filestore.ResourceStillExists",
)<{
  name: string;
}> {}

export class ResourceNotReady extends Data.TaggedError(
  "GCP.Filestore.ResourceNotReady",
)<{
  name: string;
  state: string;
}> {}

export class ResourceFailed extends Data.TaggedError(
  "GCP.Filestore.ResourceFailed",
)<{
  name: string;
  state: string;
}> {}

export const lastSegment = (value: string | undefined) => {
  if (value === undefined || value.length === 0) return "";
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const rfc1035 = (name: string, fallback = "filestore"): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `f${next}`;
  next = next.slice(0, MAX_NAME_LENGTH).replace(/-+$/g, "");
  if (next.length === 0) return fallback;
  if (!/[a-z0-9]$/.test(next)) next = `${next.slice(0, MAX_NAME_LENGTH - 1)}0`;
  return next.slice(0, MAX_NAME_LENGTH);
};

export const normalizeLocation = (
  location: string | undefined,
  fallback = DEFAULT_REGION,
) => lastSegment(location ?? fallback).toLowerCase();

export const regionOf = (location: string) => {
  const parts = location.split("-");
  const last = parts[parts.length - 1];
  if (last !== undefined && last.length === 1) {
    return parts.slice(0, -1).join("-");
  }
  return location;
};

export const toPhysicalId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
  fallback = "filestore",
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return rfc1035(explicit, fallback);
    if (existing !== undefined) return existing;
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength: MAX_NAME_LENGTH,
        lowercase: true,
      }),
      fallback,
    );
  });

export const parseName = (name: string, collection: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const collectionAt = parts.lastIndexOf(collection);
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1]
        ? parts[locationsAt + 1]!
        : DEFAULT_REGION,
    id:
      collectionAt >= 0 && parts[collectionAt + 1]
        ? parts[collectionAt + 1]!
        : lastSegment(name),
    parent:
      collectionAt > 0
        ? parts.slice(0, collectionAt).join("/")
        : parts.slice(0, Math.max(0, parts.length - 1)).join("/"),
  };
};

export const expandParent = (
  value: string,
  project: string,
  location: string,
  collection: string,
) => {
  if (value.includes("/")) return value.replace(/\/+$/, "");
  return `projects/${project}/locations/${location}/${collection}/${value}`;
};

export const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

export const hasAlchemyLabelMap = (
  labels: Record<string, string | undefined> | null | undefined,
) => Object.keys(labels ?? {}).some((key) => key.startsWith("alchemy-"));

export const fieldMask = (fields: Array<string | false | undefined>) =>
  fields
    .filter((field): field is string => typeof field === "string")
    .join(",");

export const replaceOnIdentity = (input: {
  previousId: string | undefined;
  nextId: string | undefined;
  previousLocation: string;
  nextLocation: string;
  extra?: boolean;
  previousParent?: string;
  nextParent?: string;
}) => {
  const parentChanged =
    (input.previousParent ?? "") !== "" &&
    (input.nextParent ?? "") !== "" &&
    (input.previousParent ?? "") !== (input.nextParent ?? "");
  const replace =
    (input.extra ?? false) ||
    parentChanged ||
    (input.previousId !== undefined &&
      input.nextId !== undefined &&
      input.nextId !== input.previousId) ||
    input.previousLocation !== input.nextLocation;
  if (!replace) return undefined;
  const samePhysical =
    input.previousLocation === input.nextLocation &&
    !parentChanged &&
    input.previousId !== undefined &&
    input.nextId === input.previousId;
  return {
    action: "replace" as const,
    deleteFirst: samePhysical,
  };
};

const READY_STATES = new Set(["READY"]);
const FAILED_STATES = new Set(["INVALID", "ERROR"]);

export const isReadyState = (state: string | undefined) =>
  READY_STATES.has((state ?? "").toUpperCase());

export const isFailedState = (state: string | undefined) =>
  FAILED_STATES.has((state ?? "").toUpperCase());

export const isDeletingState = (state: string | undefined) =>
  (state ?? "").toUpperCase() === "DELETING";

const alreadyExists = (error: file.Status | undefined) =>
  error?.code === 6 ||
  (error?.message ?? "").toUpperCase().includes("ALREADY_EXISTS");

const isNotFoundStatus = (error: file.Status | undefined) =>
  error?.code === 5 ||
  (error?.message ?? "").toLowerCase().includes("not found");

const isIgnorable = (
  error: file.Status | undefined,
  options?: { notFoundOk?: boolean },
) =>
  alreadyExists(error) ||
  (options?.notFoundOk === true && isNotFoundStatus(error));

export const waitForOperation = (
  operation: file.Operation,
  options?: {
    notFoundOk?: boolean;
    times?: number;
    interval?: `${number} seconds`;
  },
) =>
  Effect.gen(function* () {
    const name = operation.name;
    if (operation.done === true) {
      if (operation.error && !isIgnorable(operation.error, options)) {
        return yield* new FilestoreOperationFailed({
          operation: name ?? "",
          message: operation.error.message ?? "operation failed",
        });
      }
      return operation;
    }
    if (name === undefined || name.length === 0) {
      if (options?.notFoundOk === true) return operation;
      return yield* new FilestoreOperationFailed({
        operation: "",
        message: "operation is missing a name",
      });
    }

    const getOperation = file.getProjectsLocationsOperations({ name });
    const resolved =
      options?.notFoundOk === true
        ? getOperation.pipe(
            Effect.catchTag("NotFound", () =>
              Effect.succeed<file.Operation>({
                name,
                done: true,
              }),
            ),
          )
        : getOperation.pipe(
            Effect.retry({
              while: (error) => error._tag === "NotFound",
              times: 5,
              schedule: Schedule.exponential("250 millis"),
            }),
          );

    return yield* resolved.pipe(
      Effect.filterOrFail(
        (current) => current.done === true,
        () => new FilestoreOperationPending({ operation: name }),
      ),
      Effect.filterOrFail(
        (current) => !current.error || isIgnorable(current.error, options),
        (current) =>
          new FilestoreOperationFailed({
            operation: name,
            message: current.error?.message ?? "operation failed",
          }),
      ),
      Effect.retry({
        while: (error) => error._tag === "GCP.Filestore.OperationPending",
        times: options?.times ?? 10,
        schedule: Schedule.spaced(options?.interval ?? "8 seconds"),
      }),
    );
  });

export const waitUntilExists = <A, E extends { readonly _tag: string }, R>(
  get: Effect.Effect<A | undefined, E, R>,
  name: string,
): Effect.Effect<NonNullable<A>, E | ResourceNotResolved, R> =>
  get.pipe(
    Effect.filterOrFail(
      (value): value is NonNullable<A> => value != null,
      () => new ResourceNotResolved({ name }),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Filestore.ResourceNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

export const waitUntilGone = <A, E extends { readonly _tag: string }, R>(
  get: Effect.Effect<A | undefined, E, R>,
  name: string,
): Effect.Effect<void, E | ResourceStillExists, R> =>
  get.pipe(
    Effect.filterOrFail(
      (value) => value === undefined,
      () => new ResourceStillExists({ name }),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Filestore.ResourceStillExists",
      times: 10,
      schedule: Schedule.spaced("8 seconds"),
    }),
    Effect.asVoid,
  );

export const waitUntilReady = <A, E extends { readonly _tag: string }, R>(
  get: Effect.Effect<A | undefined, E, R>,
  name: string,
  stateOf: (value: NonNullable<A>) => string | undefined,
): Effect.Effect<
  NonNullable<A>,
  E | ResourceNotResolved | ResourceFailed | ResourceNotReady,
  R
> =>
  get.pipe(
    Effect.filterOrFail(
      (value): value is NonNullable<A> => value != null,
      () => new ResourceNotResolved({ name }),
    ),
    Effect.filterOrFail(
      (value) => !isFailedState(stateOf(value)),
      (value) =>
        new ResourceFailed({
          name,
          state: stateOf(value) ?? "",
        }),
    ),
    Effect.filterOrFail(
      (value) => {
        const state = stateOf(value) ?? "";
        return isReadyState(state) || state.length === 0;
      },
      (value) => new ResourceNotReady({ name, state: stateOf(value) ?? "" }),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Filestore.ResourceNotReady" ||
        error._tag === "GCP.Filestore.ResourceNotResolved",
      times: 10,
      schedule: Schedule.spaced("8 seconds"),
    }),
  );

export const listLabeledPages = <Page, A, E, R>(
  pages: Stream.Stream<Page, E, R>,
  items: (page: Page) => readonly A[] | undefined,
  labelsOf: (item: A) => Record<string, string | undefined> | null | undefined,
) =>
  pages.pipe(
    Stream.flatMap((page) => Stream.fromIterable(items(page) ?? [])),
    Stream.filter((item) => hasAlchemyLabelMap(labelsOf(item))),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    Effect.orElseSucceed(() => [] as A[]),
  );
