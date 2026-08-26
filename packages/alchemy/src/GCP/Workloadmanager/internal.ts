import * as workloadmanager from "@distilled.cloud/gcp/workloadmanager_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import { tagRecord } from "../../Tags.ts";
import { stripInternalLabels } from "../Labels.ts";

export const DEFAULT_LOCATION = "us-central1";
export const MAX_NAME_LENGTH = 63;
export const ACTUATION_ID_PREFIX = "alch-";

export class WorkloadmanagerOperationFailed extends Data.TaggedError(
  "GCP.Workloadmanager.OperationFailed",
)<{
  operation: string;
  message: string;
}> {}

export class WorkloadmanagerOperationPending extends Data.TaggedError(
  "GCP.Workloadmanager.OperationPending",
)<{
  operation: string;
}> {}

export class ResourceNotResolved extends Data.TaggedError(
  "GCP.Workloadmanager.ResourceNotResolved",
)<{
  name: string;
}> {}

export class ResourceStillExists extends Data.TaggedError(
  "GCP.Workloadmanager.ResourceStillExists",
)<{
  name: string;
}> {}

export class ResourceNotReady extends Data.TaggedError(
  "GCP.Workloadmanager.ResourceNotReady",
)<{
  name: string;
  state: string;
}> {}

export class ResourceFailed extends Data.TaggedError(
  "GCP.Workloadmanager.ResourceFailed",
)<{
  name: string;
  state: string;
  details: string | undefined;
}> {}

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const rfc1035 = (name: string, fallback = "workloadmanager"): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `w${next}`;
  next = next.slice(0, MAX_NAME_LENGTH).replace(/-+$/g, "");
  if (next.length === 0) return fallback;
  if (!/[a-z0-9]$/.test(next)) next = `${next.slice(0, MAX_NAME_LENGTH - 1)}0`;
  return next.slice(0, MAX_NAME_LENGTH);
};

export const normalizeLocation = (location: string | undefined) =>
  lastSegment(location ?? DEFAULT_LOCATION).toLowerCase();

export const parentOf = (project: string, location: string | undefined) =>
  `projects/${project}/locations/${normalizeLocation(location)}`;

export const toPhysicalId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
  fallback = "workloadmanager",
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

/**
 * Actuations have no labels or description. Generated ids are prefixed
 * `alch-` so `list` / nuke can find Alchemy-owned rows.
 */
export const toActuationId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return rfc1035(explicit, "alch");
    if (existing !== undefined) return existing;
    const generated = rfc1035(
      yield* createPhysicalName({
        id,
        maxLength: MAX_NAME_LENGTH - ACTUATION_ID_PREFIX.length,
        lowercase: true,
      }),
      "actuation",
    );
    const prefixed = generated.startsWith(ACTUATION_ID_PREFIX)
      ? generated
      : `${ACTUATION_ID_PREFIX}${generated}`;
    return prefixed.slice(0, MAX_NAME_LENGTH).replace(/-+$/g, "");
  });

export const hasAlchemyActuationId = (actuationId: string) =>
  actuationId.startsWith(ACTUATION_ID_PREFIX);

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
        : DEFAULT_LOCATION,
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

export const expandNamed = (
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

export const stringMap = (
  value: Record<string, string | undefined> | null | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(value ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );

export const hasAlchemyLabelMap = (
  labels: Record<string, string | undefined> | null | undefined,
) => Object.keys(labels ?? {}).some((key) => key.startsWith("alchemy-"));

export const canonical = (value: unknown): unknown => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    return value.length === 0 ? undefined : value;
  }
  if (Array.isArray(value)) {
    const items = value.map(canonical).filter((item) => item !== undefined);
    return items.length === 0 ? undefined : items;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, canonical(item)] as const)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    if (entries.length === 0) return undefined;
    return Object.fromEntries(entries);
  }
  return undefined;
};

export const fingerprint = (value: unknown): string =>
  JSON.stringify(canonical(value) ?? null);

export const fieldMask = (fields: Array<string | false | undefined>) =>
  fields
    .filter((field): field is string => typeof field === "string")
    .join(",");

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const sameStringList = (
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
) =>
  fingerprint([...(left ?? [])].slice().sort()) ===
  fingerprint([...(right ?? [])].slice().sort());

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

const READY_STATES = new Set(["READY", "SUCCEEDED", "ACTIVE"]);
const FAILED_STATES = new Set(["FAILED", "ERROR", "TIMEOUT"]);

export const isReadyState = (state: string | undefined) =>
  READY_STATES.has((state ?? "").toUpperCase());

export const isFailedState = (state: string | undefined) =>
  FAILED_STATES.has((state ?? "").toUpperCase());

const alreadyExists = (error: workloadmanager.Status | undefined) =>
  error?.code === 6 ||
  (error?.message ?? "").toUpperCase().includes("ALREADY_EXISTS");

const isNotFoundStatus = (error: workloadmanager.Status | undefined) =>
  error?.code === 5 ||
  (error?.message ?? "").toLowerCase().includes("not found");

const isIgnorable = (
  error: workloadmanager.Status | undefined,
  options?: { notFoundOk?: boolean },
) =>
  alreadyExists(error) ||
  (options?.notFoundOk === true && isNotFoundStatus(error));

export const resourceNameFromOperation = (
  operation: workloadmanager.Operation,
) => {
  const response = operation.response;
  if (
    response &&
    typeof response.name === "string" &&
    response.name.length > 0
  ) {
    return response.name;
  }
  const metadata = operation.metadata;
  if (
    metadata &&
    typeof metadata.target === "string" &&
    metadata.target.length > 0
  ) {
    return metadata.target;
  }
  if (
    metadata &&
    typeof metadata.name === "string" &&
    metadata.name.length > 0
  ) {
    return metadata.name;
  }
  return undefined;
};

export const waitForOperation = (
  operation: workloadmanager.Operation,
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
        return yield* new WorkloadmanagerOperationFailed({
          operation: name ?? "",
          message: operation.error.message ?? "operation failed",
        });
      }
      return operation;
    }
    if (name === undefined || name.length === 0) {
      if (options?.notFoundOk === true) return operation;
      return yield* new WorkloadmanagerOperationFailed({
        operation: "",
        message: "operation is missing a name",
      });
    }

    const getOperation = workloadmanager.getProjectsLocationsOperations({
      name,
    });
    const resolved =
      options?.notFoundOk === true
        ? getOperation.pipe(
            Effect.catchTag("NotFound", () =>
              Effect.succeed<workloadmanager.Operation>({
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
        () => new WorkloadmanagerOperationPending({ operation: name }),
      ),
      Effect.flatMap((current) => {
        const error = current.error;
        if (error && !isIgnorable(error, options)) {
          return Effect.fail(
            new WorkloadmanagerOperationFailed({
              operation: name,
              message: error.message ?? "operation failed",
            }),
          );
        }
        return Effect.succeed(current);
      }),
      Effect.retry({
        while: (error) => error._tag === "GCP.Workloadmanager.OperationPending",
        times: options?.times ?? 10,
        schedule: Schedule.spaced(options?.interval ?? "2 seconds"),
      }),
    );
  });

export const waitUntilExists = <A, E extends { readonly _tag: string }, R>(
  get: Effect.Effect<A, E, R>,
  name: string,
): Effect.Effect<Exclude<A, undefined>, E | ResourceNotResolved, R> =>
  get.pipe(
    Effect.filterOrFail(
      (value): value is Exclude<A, undefined> => value !== undefined,
      () => new ResourceNotResolved({ name }),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Workloadmanager.ResourceNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

export const waitUntilGone = <A, E extends { readonly _tag: string }, R>(
  get: Effect.Effect<A, E, R>,
  name: string,
): Effect.Effect<void, E | ResourceStillExists, R> =>
  get.pipe(
    Effect.filterOrFail(
      (value) => value === undefined,
      () => new ResourceStillExists({ name }),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Workloadmanager.ResourceStillExists",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
    Effect.asVoid,
  );

export const waitUntilReady = <A, E extends { readonly _tag: string }, R>(
  get: Effect.Effect<A, E, R>,
  name: string,
  stateOf: (value: Exclude<A, undefined>) => string | undefined,
  detailsOf?: (value: Exclude<A, undefined>) => string | undefined,
  options?: {
    times?: number;
    interval?: `${number} seconds`;
  },
): Effect.Effect<
  Exclude<A, undefined>,
  E | ResourceNotResolved | ResourceFailed | ResourceNotReady,
  R
> =>
  get.pipe(
    Effect.filterOrFail(
      (value): value is Exclude<A, undefined> => value !== undefined,
      () => new ResourceNotResolved({ name }),
    ),
    Effect.filterOrFail(
      (value) => !isFailedState(stateOf(value)),
      (value) =>
        new ResourceFailed({
          name,
          state: stateOf(value) ?? "",
          details: detailsOf?.(value),
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
        error._tag === "GCP.Workloadmanager.ResourceNotReady" ||
        error._tag === "GCP.Workloadmanager.ResourceNotResolved",
      times: options?.times ?? 10,
      schedule: Schedule.spaced(options?.interval ?? "2 seconds"),
    }),
  );

export const listAtLocation = <A, E, R>(
  project: string,
  list: (parent: string) => Effect.Effect<A[], E, R>,
): Effect.Effect<A[], never, R> =>
  list(`projects/${project}/locations/-`).pipe(
    Effect.catch(() =>
      list(`projects/${project}/locations/${DEFAULT_LOCATION}`).pipe(
        Effect.orElseSucceed((): A[] => []),
      ),
    ),
  );

export const listAtNested = <A, E, R>(
  project: string,
  nested: string,
  list: (parent: string) => Effect.Effect<A[], E, R>,
): Effect.Effect<A[], never, R> =>
  list(`projects/${project}/locations/-/${nested}`).pipe(
    Effect.catch(() =>
      list(`projects/${project}/locations/${DEFAULT_LOCATION}/${nested}`).pipe(
        Effect.orElseSucceed((): A[] => []),
      ),
    ),
  );

export const listLabeledPages = <Page, A, E, R>(
  pages: Stream.Stream<Page, E, R>,
  items: (page: Page) => readonly A[] | undefined,
  labelsOf: (item: A) => Record<string, string | undefined> | null | undefined,
): Effect.Effect<A[], never, R> =>
  pages.pipe(
    Stream.flatMap((page) => Stream.fromIterable(items(page) ?? [])),
    Stream.filter((item) => hasAlchemyLabelMap(labelsOf(item))),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    Effect.orElseSucceed((): A[] => []),
  );

export const listPages = <Page, A, E, R>(
  pages: Stream.Stream<Page, E, R>,
  items: (page: Page) => readonly A[] | undefined,
  keep: (item: A) => boolean,
): Effect.Effect<A[], never, R> =>
  pages.pipe(
    Stream.flatMap((page) => Stream.fromIterable(items(page) ?? [])),
    Stream.filter(keep),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    Effect.orElseSucceed((): A[] => []),
  );
