import * as beyondcorp from "@distilled.cloud/gcp/beyondcorp_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import { tagRecord } from "../../Tags.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
  stripInternalLabels,
} from "../Labels.ts";

export const DEFAULT_LOCATION = "us-central1";
export const DEFAULT_GLOBAL = "global";
export const MAX_NAME_LENGTH = 63;
export const MAX_DISPLAY_NAME_LENGTH = 64;
export const DEFAULT_CONNECTION_TYPE = "TCP_PROXY";
export const DEFAULT_GATEWAY_TYPE = "TCP_PROXY";
export const DEFAULT_HOST_TYPE = "GCP_REGIONAL_MIG";
export const DEFAULT_GATEWAY_KIND = "GCP_REGIONAL_MIG";

export class ResourceNotResolved extends Data.TaggedError(
  "GCP.Beyondcorp.ResourceNotResolved",
)<{
  name: string;
}> {}

export class ResourceStillExists extends Data.TaggedError(
  "GCP.Beyondcorp.ResourceStillExists",
)<{
  name: string;
}> {}

export class ResourceFailed extends Data.TaggedError(
  "GCP.Beyondcorp.ResourceFailed",
)<{
  name: string;
  state: string | undefined;
}> {}

export class ResourceNotReady extends Data.TaggedError(
  "GCP.Beyondcorp.ResourceNotReady",
)<{
  name: string;
  state: string | undefined;
}> {}

export class BeyondcorpOperationFailed extends Data.TaggedError(
  "GCP.Beyondcorp.OperationFailed",
)<{
  operation: string;
  message: string;
}> {}

export class BeyondcorpOperationPending extends Data.TaggedError(
  "GCP.Beyondcorp.OperationPending",
)<{
  operation: string;
}> {}

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const rfc1035 = (name: string, fallback = "beyondcorp"): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `${fallback[0] ?? "b"}${next}`;
  next = next.slice(0, MAX_NAME_LENGTH).replace(/-+$/g, "");
  if (next.length === 0) next = fallback;
  if (next.length < 4)
    next = `${next}${fallback}xxxx`.slice(0, MAX_NAME_LENGTH);
  if (!/[a-z0-9]$/.test(next)) {
    next = `${next.slice(0, MAX_NAME_LENGTH - 1)}0`;
  }
  return next.slice(0, MAX_NAME_LENGTH);
};

export const normalizeLocation = (
  location: string | undefined,
  fallback = DEFAULT_LOCATION,
) => lastSegment(location ?? fallback).toLowerCase();

export const parentOf = (project: string, location: string) =>
  `projects/${project}/locations/${location}`;

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
    parent:
      collectionAt > 0
        ? parts.slice(0, collectionAt).join("/")
        : parts.slice(0, Math.max(0, parts.length - 1)).join("/"),
  };
};

export const expandName = (
  value: string,
  project: string,
  location: string,
  collection: string,
) => {
  const next = value.replace(/\/+$/, "");
  if (next.includes("/")) return next;
  return `projects/${project}/locations/${location}/${collection}/${next}`;
};

export const toPhysicalId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
  fallback = "beyondcorp",
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

export const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

export const hasAlchemyLabelMap = (
  labels: Record<string, string | undefined> | null | undefined,
) => Object.keys(labels ?? {}).some((key) => key.startsWith("alchemy-"));

const markerOf = (stack: string, stage: string, id: string) =>
  `[alchemy ${alchemyLabelKeys.stack}=${stack} ${alchemyLabelKeys.stage}=${stage} ${alchemyLabelKeys.id}=${id}]`;

const compactMarkerOf = (stack: string, stage: string, id: string) =>
  `[alc ${stack} ${stage} ${id}]`;

const shrinkMarker = (
  labels: Record<string, string>,
  maxLength: number,
  build: (stack: string, stage: string, id: string) => string,
) => {
  let stack = labels[alchemyLabelKeys.stack] ?? "x";
  let stage = labels[alchemyLabelKeys.stage] ?? "x";
  let id = labels[alchemyLabelKeys.id] ?? "x";
  let marker = build(stack, stage, id);
  while (
    marker.length > maxLength &&
    (stack.length > 1 || stage.length > 1 || id.length > 1)
  ) {
    if (stack.length >= stage.length && stack.length >= id.length) {
      stack = stack.slice(0, -1);
    } else if (stage.length >= id.length) {
      stage = stage.slice(0, -1);
    } else {
      id = id.slice(0, -1);
    }
    marker = build(stack, stage, id);
  }
  return marker.slice(0, maxLength);
};

export const encodeOwnershipLine = (
  labels: Record<string, string>,
  text: string | undefined,
  maxLength = MAX_DISPLAY_NAME_LENGTH,
): string => {
  const marker =
    maxLength < 54
      ? shrinkMarker(labels, maxLength, compactMarkerOf)
      : shrinkMarker(labels, maxLength, markerOf);
  const trimmed = text?.replace(/[\r\n]+/g, " ").trim();
  if (!trimmed) return marker;
  return `${marker} ${trimmed}`.slice(0, maxLength);
};

export const parseOwnership = (
  text: string | undefined,
): {
  labels: Record<string, string>;
  text: string | undefined;
} => {
  if (text?.startsWith("[alc ")) {
    const end = text.indexOf("]");
    if (end < 0) return { labels: {}, text };
    const parts = text.slice("[alc ".length, end).trim().split(/\s+/);
    const labels: Record<string, string> = {};
    if (parts[0]) labels[alchemyLabelKeys.stack] = parts[0]!;
    if (parts[1]) labels[alchemyLabelKeys.stage] = parts[1]!;
    if (parts[2]) labels[alchemyLabelKeys.id] = parts[2]!;
    const rest = text.slice(end + 1).replace(/^[\s\n]+/, "");
    return { labels, text: rest.length > 0 ? rest : undefined };
  }
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
  const rest = text.slice(end + 1).replace(/^[\s\n]+/, "");
  return { labels, text: rest.length > 0 ? rest : undefined };
};

export const hasOwnershipMarker = (text: string | undefined) =>
  Object.keys(parseOwnership(text).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

const prefixMatch = (expected: string, observed: string) =>
  expected === observed ||
  expected.startsWith(observed) ||
  observed.startsWith(expected);

export const ownedByAlchemy = (id: string, text: string | undefined) =>
  Effect.gen(function* () {
    const expected = yield* createInternalLabels(id);
    const { labels } = parseOwnership(text);
    if (!hasOwnershipMarker(text)) return false;
    const exact = yield* hasAlchemyLabels(id, labels);
    if (exact) return true;
    return (
      prefixMatch(
        expected[alchemyLabelKeys.stack] ?? "",
        labels[alchemyLabelKeys.stack] ?? "",
      ) &&
      prefixMatch(
        expected[alchemyLabelKeys.stage] ?? "",
        labels[alchemyLabelKeys.stage] ?? "",
      ) &&
      prefixMatch(
        expected[alchemyLabelKeys.id] ?? "",
        labels[alchemyLabelKeys.id] ?? "",
      )
    );
  });

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

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const sameJson = (left: unknown, right: unknown) =>
  fingerprint(left) === fingerprint(right);

export const sameStringList = (
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
) =>
  JSON.stringify([...(left ?? [])].map(lastSegment).sort()) ===
  JSON.stringify([...(right ?? [])].map(lastSegment).sort());

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
    lastSegment(input.previousParent ?? "") !==
      lastSegment(input.nextParent ?? "");
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

const READY_STATES = new Set(["CREATED", "RUNNING"]);
const FAILED_STATES = new Set(["ERROR"]);

export const isReadyState = (state: string | undefined) => {
  const value = (state ?? "").toUpperCase();
  return value.length === 0 || READY_STATES.has(value);
};

export const isFailedState = (state: string | undefined) =>
  FAILED_STATES.has((state ?? "").toUpperCase());

const alreadyExists = (error: beyondcorp.GoogleRpcStatus | undefined) =>
  error?.code === 6 ||
  (error?.message ?? "").toUpperCase().includes("ALREADY_EXISTS");

const isNotFoundStatus = (error: beyondcorp.GoogleRpcStatus | undefined) =>
  error?.code === 5 ||
  (error?.message ?? "").toLowerCase().includes("not found");

const isIgnorable = (
  error: beyondcorp.GoogleRpcStatus | undefined,
  options?: { notFoundOk?: boolean },
) =>
  alreadyExists(error) ||
  (options?.notFoundOk === true && isNotFoundStatus(error));

export const waitForOperation = (
  operation: beyondcorp.GoogleLongrunningOperation,
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
        return yield* new BeyondcorpOperationFailed({
          operation: name ?? "",
          message: operation.error.message ?? "operation failed",
        });
      }
      return operation;
    }
    if (name === undefined || name.length === 0) {
      if (options?.notFoundOk === true) return operation;
      return yield* new BeyondcorpOperationFailed({
        operation: "",
        message: "operation is missing a name",
      });
    }

    const getOperation = beyondcorp.getProjectsLocationsOperations({ name });
    const resolved =
      options?.notFoundOk === true
        ? getOperation.pipe(
            Effect.catchTag("NotFound", () =>
              Effect.succeed<beyondcorp.GoogleLongrunningOperation>({
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
        () => new BeyondcorpOperationPending({ operation: name }),
      ),
      Effect.flatMap((current) => {
        const error = current.error;
        if (error && !isIgnorable(error, options)) {
          return Effect.fail(
            new BeyondcorpOperationFailed({
              operation: name,
              message: error.message ?? "operation failed",
            }),
          );
        }
        return Effect.succeed(current);
      }),
      Effect.retry({
        while: (error) => error._tag === "GCP.Beyondcorp.OperationPending",
        times: options?.times ?? 10,
        schedule: Schedule.spaced(options?.interval ?? "3 seconds"),
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
      while: (error) => error._tag === "GCP.Beyondcorp.ResourceNotResolved",
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
    Effect.asVoid,
    Effect.retry({
      while: (error) => error._tag === "GCP.Beyondcorp.ResourceStillExists",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

export const waitUntilReady = <A, E extends { readonly _tag: string }, R>(
  get: Effect.Effect<A, E, R>,
  name: string,
  stateOf: (value: Exclude<A, undefined>) => string | undefined,
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
      (value) => new ResourceFailed({ name, state: stateOf(value) }),
    ),
    Effect.filterOrFail(
      (value) => {
        const state = stateOf(value);
        return isReadyState(state) || (state ?? "").toUpperCase() === "DOWN";
      },
      (value) => new ResourceNotReady({ name, state: stateOf(value) }),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Beyondcorp.ResourceNotReady" ||
        error._tag === "GCP.Beyondcorp.ResourceNotResolved",
      times: 8,
      schedule: Schedule.spaced("3 seconds"),
    }),
  );

export const collectPages = <Page, Item, E, R>(
  stream: Stream.Stream<Page, E, R>,
  pick: (page: Page) => readonly Item[] | undefined,
): Effect.Effect<Item[], never, R> =>
  stream.pipe(
    Stream.flatMap((page) => Stream.fromIterable(pick(page) ?? [])),
    Stream.runFold(
      (): Item[] => [],
      (acc, item) => {
        acc.push(item);
        return acc;
      },
    ),
    Effect.orElseSucceed((): Item[] => []),
  );

export const listAtLocation = <A, E, R>(
  project: string,
  fallbackLocation: string,
  list: (parent: string) => Effect.Effect<A[], E, R>,
): Effect.Effect<A[], never, R> =>
  list(`projects/${project}/locations/-`).pipe(
    Effect.catchIf(
      () => true,
      () => list(`projects/${project}/locations/${fallbackLocation}`),
    ),
    Effect.orElseSucceed((): A[] => []),
  );
