import * as vmwareengine from "@distilled.cloud/gcp/vmwareengine_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";

export const DEFAULT_GLOBAL = "global";
export const DEFAULT_LOCATION = "us-central1";
export const DEFAULT_ZONE = "us-central1-a";
export const MAX_NAME_LENGTH = 63;

export { createInternalLabels, hasAlchemyLabels };

export class VmwareengineNotResolved extends Data.TaggedError(
  "GCP.Vmwareengine.NotResolved",
)<{
  name: string;
}> {}

export class VmwareengineStillExists extends Data.TaggedError(
  "GCP.Vmwareengine.StillExists",
)<{
  name: string;
}> {}

export class VmwareengineFailed extends Data.TaggedError(
  "GCP.Vmwareengine.Failed",
)<{
  name: string;
  state: string | undefined;
}> {}

export class VmwareengineOperationFailed extends Data.TaggedError(
  "GCP.Vmwareengine.OperationFailed",
)<{
  operation: string;
  message: string;
}> {}

export class VmwareengineOperationPending extends Data.TaggedError(
  "GCP.Vmwareengine.OperationPending",
)<{
  operation: string;
}> {}

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const rfc1035 = (name: string, fallback = "resource"): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  if (!/^[a-z]/.test(next)) {
    next = `v${next}`;
  }
  next = next.slice(0, MAX_NAME_LENGTH).replace(/-+$/, "");
  return next.length > 0 ? next : fallback;
};

export const normalizeLocation = (
  location: string | undefined,
  fallback: string,
) => lastSegment(location ?? fallback).toLowerCase();

export const parentOf = (project: string, location: string) =>
  `projects/${project}/locations/${location}`;

export const canonicalizeLink = (value: string | undefined) => {
  if (value === undefined || value.length === 0) return "";
  return value
    .replace(/^https?:\/\/[^/]+\//, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
};

export const parseName = (
  name: string,
  collection: string,
  fallbackLocation: string,
) => {
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
        : fallbackLocation,
    id:
      collectionAt >= 0 && parts[collectionAt + 1]
        ? parts[collectionAt + 1]!
        : lastSegment(name),
    parent: collectionAt > 0 ? parts.slice(0, collectionAt).join("/") : "",
  };
};

export const locationFromName = (name: string, fallback: string) => {
  const canonical = canonicalizeLink(name);
  if (!canonical.includes("/locations/")) return fallback;
  return parseName(canonical, "locations", fallback).location;
};

export const expandName = (
  value: string,
  project: string,
  location: string,
  collection: string,
) => {
  const canonical = canonicalizeLink(value);
  if (
    canonical.includes(`/${collection}/`) ||
    canonical.includes("/locations/")
  ) {
    return canonical;
  }
  return `${parentOf(project, location)}/${collection}/${rfc1035(canonical, collection)}`;
};

export const toPhysicalId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
  fallback = "resource",
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

export const encodeOwnership = (
  labels: Record<string, string>,
  text: string | undefined,
): string => {
  const marker = `[alchemy ${alchemyLabelKeys.stack}=${labels[alchemyLabelKeys.stack]} ${alchemyLabelKeys.stage}=${labels[alchemyLabelKeys.stage]} ${alchemyLabelKeys.id}=${labels[alchemyLabelKeys.id]}]`;
  const trimmed = text?.trim();
  return trimmed && trimmed.length > 0 ? `${marker}\n${trimmed}` : marker;
};

export const parseOwnership = (
  text: string | undefined,
): {
  labels: Record<string, string>;
  text: string | undefined;
} => {
  if (!text?.startsWith("[alchemy ")) {
    return { labels: {}, text };
  }
  const end = text.indexOf("]");
  if (end < 0) return { labels: {}, text };
  const labels: Record<string, string> = {};
  for (const part of text.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const rest = text.slice(end + 1).replace(/^\s+/, "");
  return { labels, text: rest.length > 0 ? rest : undefined };
};

export const hasOwnershipMarker = (text: string | undefined) =>
  Object.keys(parseOwnership(text).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

export const sameJson = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

export const changedFields = (
  pairs: ReadonlyArray<readonly [string, boolean]>,
) => pairs.filter(([, changed]) => changed).map(([field]) => field);

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
    canonicalizeLink(input.previousParent) !==
      canonicalizeLink(input.nextParent);
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

const alreadyExists = (error: vmwareengine.Status | undefined) =>
  error?.code === 6 ||
  (error?.message ?? "").toUpperCase().includes("ALREADY_EXISTS");

const isNotFoundStatus = (error: vmwareengine.Status | undefined) =>
  error?.code === 5 ||
  (error?.message ?? "").toLowerCase().includes("not found");

export const waitForOperation = (
  operation: vmwareengine.Operation,
  options?: { notFoundOk?: boolean },
) =>
  Effect.gen(function* () {
    const name = operation.name;
    if (operation.done === true) {
      if (operation.error) {
        if (alreadyExists(operation.error)) return operation;
        if (options?.notFoundOk === true && isNotFoundStatus(operation.error)) {
          return operation;
        }
        return yield* new VmwareengineOperationFailed({
          operation: name ?? "",
          message: operation.error.message ?? "operation failed",
        });
      }
      return operation;
    }
    if (name === undefined || name.length === 0) {
      if (options?.notFoundOk === true) return operation;
      return yield* new VmwareengineOperationFailed({
        operation: "",
        message: "operation is missing a name",
      });
    }

    const getOperation = vmwareengine.getProjectsLocationsOperations({
      name,
    });
    const resolved =
      options?.notFoundOk === true
        ? getOperation.pipe(
            Effect.catchTag("NotFound", () =>
              Effect.succeed({
                name,
                done: true,
              } satisfies vmwareengine.Operation),
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
        () => new VmwareengineOperationPending({ operation: name }),
      ),
      Effect.flatMap((current) => {
        const error = current.error;
        if (!error || alreadyExists(error)) {
          return Effect.succeed(current);
        }
        if (options?.notFoundOk === true && isNotFoundStatus(error)) {
          return Effect.succeed(current);
        }
        return Effect.fail(
          new VmwareengineOperationFailed({
            operation: name,
            message: error.message ?? "operation failed",
          }),
        );
      }),
      Effect.retry({
        while: (error) => error._tag === "GCP.Vmwareengine.OperationPending",
        times: 10,
        schedule: Schedule.spaced("8 seconds"),
      }),
    );
  });

export const waitUntilPresent = <A extends object, E, R>(
  get: Effect.Effect<A | undefined, E, R>,
  name: string,
): Effect.Effect<A, E | VmwareengineNotResolved, R> =>
  get.pipe(
    Effect.filterOrFail(
      (value): value is A => value !== undefined,
      () => new VmwareengineNotResolved({ name }),
    ),
    Effect.retry({
      while: (error) => error instanceof VmwareengineNotResolved,
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

export const waitUntilGone = <A, E, R>(
  get: Effect.Effect<A | undefined, E, R>,
  name: string,
): Effect.Effect<void, E | VmwareengineStillExists, R> =>
  get.pipe(
    Effect.filterOrFail(
      (value): value is undefined => value === undefined,
      () => new VmwareengineStillExists({ name }),
    ),
    Effect.as(undefined as void),
    Effect.retry({
      while: (error) => error instanceof VmwareengineStillExists,
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const PENDING_STATES = new Set([
  "STATE_UNSPECIFIED",
  "CREATING",
  "UPDATING",
  "DELETING",
  "PURGING",
  "REPAIRING",
  "RECONCILING",
]);

const FAILED_STATES = new Set(["FAILED", "DELETE_FAILED"]);

export const waitUntilReady = <A extends object, E, R>(
  get: Effect.Effect<A | undefined, E, R>,
  name: string,
  stateOf: (value: A) => string | undefined,
): Effect.Effect<A, E | VmwareengineNotResolved | VmwareengineFailed, R> =>
  get.pipe(
    Effect.filterOrFail(
      (value): value is A => {
        if (value === undefined) return false;
        return !PENDING_STATES.has(stateOf(value) ?? "");
      },
      () => new VmwareengineNotResolved({ name }),
    ),
    Effect.filterOrFail(
      (value) => !FAILED_STATES.has(stateOf(value) ?? ""),
      (value) => new VmwareengineFailed({ name, state: stateOf(value) }),
    ),
    Effect.retry({
      while: (error) => error instanceof VmwareengineNotResolved,
      times: 10,
      schedule: Schedule.spaced("8 seconds"),
    }),
  );

export const collectPages = <Page, Item, E, R>(
  stream: Stream.Stream<Page, E, R>,
  pick: (page: Page) => readonly Item[] | undefined,
): Effect.Effect<Item[], never, R> =>
  stream.pipe(
    Stream.flatMap((page) =>
      Stream.fromIterable(pick(page) ?? ([] as readonly Item[])),
    ),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    Effect.orElseSucceed((): Item[] => []),
  );

export const listAcrossLocations = <A, E, R>(
  project: string,
  list: (parent: string) => Effect.Effect<A[], E, R>,
): Effect.Effect<A[], never, R> =>
  Effect.firstSuccessOf([
    list(parentOf(project, "-")),
    Effect.forEach(
      [DEFAULT_GLOBAL, DEFAULT_LOCATION, DEFAULT_ZONE] as const,
      (location) =>
        list(parentOf(project, location)).pipe(
          Effect.orElseSucceed((): A[] => []),
        ),
      { concurrency: 3 },
    ).pipe(Effect.map((chunks) => chunks.flat())),
  ]).pipe(Effect.orElseSucceed((): A[] => []));
