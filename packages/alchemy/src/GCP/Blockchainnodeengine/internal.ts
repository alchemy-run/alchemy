import * as bne from "@distilled.cloud/gcp/blockchainnodeengine_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import { tagRecord } from "../../Tags.ts";
import { stripInternalLabels } from "../Labels.ts";

export const DEFAULT_LOCATION = "us-central1";
export const DEFAULT_BLOCKCHAIN_TYPE = "ETHEREUM";
export const DEFAULT_NETWORK = "TESTNET_SEPOLIA";
export const DEFAULT_NODE_TYPE = "FULL";
export const DEFAULT_EXECUTION_CLIENT = "GETH";
export const DEFAULT_CONSENSUS_CLIENT = "LIGHTHOUSE";
export const MAX_NAME_LENGTH = 63;
export const COLLECTION = "blockchainNodes";

export class BlockchainnodeengineOperationFailed extends Data.TaggedError(
  "GCP.Blockchainnodeengine.OperationFailed",
)<{
  operation: string;
  message: string;
}> {}

export class BlockchainnodeengineOperationPending extends Data.TaggedError(
  "GCP.Blockchainnodeengine.OperationPending",
)<{
  operation: string;
}> {}

export class ResourceNotResolved extends Data.TaggedError(
  "GCP.Blockchainnodeengine.NotResolved",
)<{
  name: string;
}> {}

export class ResourceStillExists extends Data.TaggedError(
  "GCP.Blockchainnodeengine.StillExists",
)<{
  name: string;
}> {}

export class ResourceNotReady extends Data.TaggedError(
  "GCP.Blockchainnodeengine.NotReady",
)<{
  name: string;
  state: string;
}> {}

export class ResourceFailed extends Data.TaggedError(
  "GCP.Blockchainnodeengine.Failed",
)<{
  name: string;
  state: string;
  message: string | undefined;
}> {}

export const lastSegment = (value: string | undefined) => {
  if (value === undefined || value.length === 0) return "";
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const rfc1035 = (name: string, fallback = "node"): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `n${next}`;
  next = next.slice(0, MAX_NAME_LENGTH).replace(/-+$/g, "");
  if (next.length === 0) return fallback;
  if (!/[a-z0-9]$/.test(next)) next = `${next.slice(0, MAX_NAME_LENGTH - 1)}0`;
  return next.slice(0, MAX_NAME_LENGTH);
};

export const normalizeLocation = (location: string | undefined) =>
  lastSegment(location ?? DEFAULT_LOCATION).toLowerCase();

export const normalizeEnum = (value: string | undefined, fallback: string) => {
  const next = (value ?? fallback).toUpperCase();
  return next.length === 0 || next.endsWith("_UNSPECIFIED") ? fallback : next;
};

export const parentOf = (project: string, location: string | undefined) =>
  `projects/${project}/locations/${normalizeLocation(location)}`;

export const resourceName = (
  project: string,
  location: string,
  blockchainNodeId: string,
) => `${parentOf(project, location)}/${COLLECTION}/${blockchainNodeId}`;

export const toPhysicalId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
  fallback = "node",
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

export const parseName = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const collectionAt = parts.lastIndexOf(COLLECTION);
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
  };
};

export const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

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

export const sameEnum = (left: string | undefined, right: string | undefined) =>
  (left ?? "").toUpperCase() === (right ?? "").toUpperCase();

export const sameStringList = (
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
) =>
  fingerprint([...(left ?? [])].map((value) => value.toLowerCase()).sort()) ===
  fingerprint([...(right ?? [])].map((value) => value.toLowerCase()).sort());

export const replaceOnIdentity = (input: {
  previousId: string | undefined;
  nextId: string | undefined;
  previousLocation: string;
  nextLocation: string;
  extra?: boolean;
}) => {
  const replace =
    (input.extra ?? false) ||
    (input.previousId !== undefined &&
      input.nextId !== undefined &&
      input.nextId !== input.previousId) ||
    input.previousLocation !== input.nextLocation;
  if (!replace) return undefined;
  const samePhysical =
    input.previousLocation === input.nextLocation &&
    input.previousId !== undefined &&
    input.nextId === input.previousId;
  return {
    action: "replace" as const,
    deleteFirst: samePhysical,
  };
};

const READY_STATES = new Set(["RUNNING", "SYNCING"]);
const FAILED_STATES = new Set(["ERROR", "DELETING"]);

export const isReadyState = (state: string | undefined) => {
  const value = (state ?? "").toUpperCase();
  return value.length === 0 || READY_STATES.has(value);
};

export const isFailedState = (state: string | undefined) =>
  FAILED_STATES.has((state ?? "").toUpperCase());

const alreadyExists = (error: bne.Status | undefined) =>
  error?.code === 6 ||
  (error?.message ?? "").toUpperCase().includes("ALREADY_EXISTS");

const isNotFoundStatus = (error: bne.Status | undefined) =>
  error?.code === 5 ||
  (error?.message ?? "").toLowerCase().includes("not found");

const isIgnorable = (
  error: bne.Status | undefined,
  options?: { notFoundOk?: boolean },
) =>
  alreadyExists(error) ||
  (options?.notFoundOk === true && isNotFoundStatus(error));

export const waitForOperation = (
  operation: bne.Operation,
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
        return yield* new BlockchainnodeengineOperationFailed({
          operation: name ?? "",
          message: operation.error.message ?? "operation failed",
        });
      }
      return operation;
    }
    if (name === undefined || name.length === 0) {
      if (options?.notFoundOk === true) return operation;
      return yield* new BlockchainnodeengineOperationFailed({
        operation: "",
        message: "operation is missing a name",
      });
    }

    const getOperation = bne.getProjectsLocationsOperations({ name });
    const resolved =
      options?.notFoundOk === true
        ? getOperation.pipe(
            Effect.catchTag("NotFound", () =>
              Effect.succeed<bne.Operation>({
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
        () => new BlockchainnodeengineOperationPending({ operation: name }),
      ),
      Effect.filterOrFail(
        (current) => !current.error || isIgnorable(current.error, options),
        (current) =>
          new BlockchainnodeengineOperationFailed({
            operation: name,
            message: current.error?.message ?? "operation failed",
          }),
      ),
      Effect.retry({
        while: (error) =>
          error._tag === "GCP.Blockchainnodeengine.OperationPending",
        times: options?.times ?? 10,
        schedule: Schedule.spaced(options?.interval ?? "8 seconds"),
      }),
    );
  });

export const waitUntilExists = <A, E, R>(
  get: Effect.Effect<A | undefined, E, R>,
  name: string,
): Effect.Effect<NonNullable<A>, E | ResourceNotResolved, R> =>
  get.pipe(
    Effect.filterOrFail(
      (value): value is NonNullable<A> => value != null,
      () => new ResourceNotResolved({ name }),
    ),
    Effect.retry({
      while: (error) => error instanceof ResourceNotResolved,
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

export const waitUntilGone = <A, E, R>(
  get: Effect.Effect<A | undefined, E, R>,
  name: string,
): Effect.Effect<void, E | ResourceStillExists, R> =>
  get.pipe(
    Effect.filterOrFail(
      (value) => value === undefined,
      () => new ResourceStillExists({ name }),
    ),
    Effect.retry({
      while: (error) => error instanceof ResourceStillExists,
      times: 10,
      schedule: Schedule.spaced("8 seconds"),
    }),
    Effect.asVoid,
  );

export const waitUntilReady = <A, E, R>(
  get: Effect.Effect<A | undefined, E, R>,
  name: string,
  stateOf: (value: NonNullable<A>) => string | undefined,
  messageOf?: (value: NonNullable<A>) => string | undefined,
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
          message: messageOf?.(value),
        }),
    ),
    Effect.filterOrFail(
      (value) => isReadyState(stateOf(value)),
      (value) =>
        new ResourceNotReady({
          name,
          state: stateOf(value) ?? "",
        }),
    ),
    Effect.retry({
      while: (error) =>
        error instanceof ResourceNotReady ||
        error instanceof ResourceNotResolved,
      times: 10,
      schedule: Schedule.spaced("8 seconds"),
    }),
  );

export const listAtLocation = <A, E, R>(
  project: string,
  list: (parent: string) => Effect.Effect<A[], E, R>,
): Effect.Effect<A[], never, R> =>
  Effect.firstSuccessOf<Effect.Effect<A[], E, R>>([
    list(`projects/${project}/locations/-`),
    list(`projects/${project}/locations/${DEFAULT_LOCATION}`),
  ]).pipe(Effect.orElseSucceed((): A[] => []));

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
