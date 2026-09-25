import * as apim from "@distilled.cloud/gcp/apim_v1alpha";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";

export const DEFAULT_LOCATION = "us-central1";
export const MAX_NAME_LENGTH = 63;
export const MIN_NAME_LENGTH = 4;
export const ALCHEMY_ID_PREFIX = "alch-";

export type PscNetworkConfig = {
  /** VPC network `projects/{project}/global/networks/{network}`. */
  network: string;
  /**
   * Subnetwork
   * `projects/{project}/regions/{region}/subnetworks/{subnet}`.
   */
  subnetwork: string;
};

export type GclbObservationSource = {
  /** VPC networks whose load balancers are observed. Currently one. */
  pscNetworkConfigs: PscNetworkConfig[];
};

export class ApimOperationFailed extends Data.TaggedError(
  "GCP.Apim.OperationFailed",
)<{
  operation: string;
  message: string;
}> {}

export class ApimOperationPending extends Data.TaggedError(
  "GCP.Apim.OperationPending",
)<{
  operation: string;
}> {}

export class ResourceNotResolved extends Data.TaggedError(
  "GCP.Apim.NotResolved",
)<{
  name: string;
}> {}

export class ResourceStillExists extends Data.TaggedError(
  "GCP.Apim.StillExists",
)<{
  name: string;
}> {}

export class ResourceNotReady extends Data.TaggedError("GCP.Apim.NotReady")<{
  name: string;
  state: string;
}> {}

export class ResourceFailed extends Data.TaggedError("GCP.Apim.Failed")<{
  name: string;
  state: string;
}> {}

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const rfc1035 = (name: string, fallback = "apim"): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `${fallback[0] ?? "a"}${next}`;
  next = next.slice(0, MAX_NAME_LENGTH).replace(/-+$/g, "");
  if (next.length === 0) return fallback;
  if (!/[a-z0-9]$/.test(next)) next = `${next.slice(0, MAX_NAME_LENGTH - 1)}0`;
  if (next.length < MIN_NAME_LENGTH) {
    next = `${next}${"x".repeat(MIN_NAME_LENGTH)}`.slice(0, MIN_NAME_LENGTH);
  }
  return next.slice(0, MAX_NAME_LENGTH);
};

export const normalizeLocation = (location: string | undefined) =>
  lastSegment(location ?? DEFAULT_LOCATION).toLowerCase();

export const parentOf = (project: string, location: string | undefined) =>
  `projects/${project}/locations/${normalizeLocation(location)}`;

export const resourceName = (
  project: string,
  location: string,
  collection: string,
  id: string,
) => `${parentOf(project, location)}/${collection}/${id}`;

export const toPhysicalId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
  fallback = "apim",
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return rfc1035(explicit, fallback);
    if (existing !== undefined) return existing;
    const generated = rfc1035(
      yield* createPhysicalName({
        id,
        maxLength: MAX_NAME_LENGTH - ALCHEMY_ID_PREFIX.length,
        lowercase: true,
      }),
      fallback,
    );
    const prefixed = generated.startsWith(ALCHEMY_ID_PREFIX)
      ? generated
      : `${ALCHEMY_ID_PREFIX}${generated}`;
    return rfc1035(prefixed, fallback);
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

export const hasAlchemyId = (id: string | undefined) =>
  (id ?? "").startsWith(ALCHEMY_ID_PREFIX);

export const projectIdOf = (value: string | undefined, fallback: string) => {
  if (value === undefined || value.length === 0) return fallback;
  const parts = value.split("/").filter((part) => part.length > 0);
  const at = parts.lastIndexOf("projects");
  if (at >= 0 && parts[at + 1]) return parts[at + 1]!;
  return fallback;
};

export const expandNetwork = (value: string, project: string) => {
  const trimmed = value.replace(/\/+$/, "");
  if (trimmed.includes("/networks/")) {
    const owner = projectIdOf(trimmed, project);
    return `projects/${owner}/global/networks/${lastSegment(trimmed)}`;
  }
  return `projects/${project}/global/networks/${trimmed}`;
};

export const expandSubnetwork = (
  value: string,
  project: string,
  location: string,
) => {
  const trimmed = value.replace(/\/+$/, "");
  if (trimmed.includes("/subnetworks/")) {
    const owner = projectIdOf(trimmed, project);
    const parts = trimmed.split("/").filter((part) => part.length > 0);
    const regionsAt = parts.lastIndexOf("regions");
    const region =
      regionsAt >= 0 && parts[regionsAt + 1] ? parts[regionsAt + 1]! : location;
    return `projects/${owner}/regions/${region}/subnetworks/${lastSegment(trimmed)}`;
  }
  return `projects/${project}/regions/${location}/subnetworks/${trimmed}`;
};

export const expandObservationSource = (
  value: string,
  project: string,
  location: string,
) => {
  const trimmed = value.replace(/\/+$/, "");
  if (trimmed.includes("/observationSources/")) return trimmed;
  return resourceName(project, location, "observationSources", trimmed);
};

export const expandGclb = (
  source: GclbObservationSource | undefined,
  project: string,
  location: string,
): apim.GclbObservationSource | undefined => {
  if (source === undefined) return undefined;
  return {
    pscNetworkConfigs: (source.pscNetworkConfigs ?? []).map((config) => ({
      network: expandNetwork(config.network, project),
      subnetwork: expandSubnetwork(config.subnetwork, project, location),
    })),
  };
};

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

export const sameJson = (left: unknown, right: unknown) =>
  fingerprint(left) === fingerprint(right);

export const sameStringList = (
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
) =>
  fingerprint([...(left ?? [])].map(lastSegment).sort()) ===
  fingerprint([...(right ?? [])].map(lastSegment).sort());

export const replaceOnIdentity = (input: {
  previousId: string | undefined;
  nextId: string | undefined;
  previousLocation: string;
  nextLocation: string;
  extra?: boolean;
  deleteFirst?: boolean;
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
    deleteFirst: input.deleteFirst ?? samePhysical,
  };
};

const alreadyExists = (error: apim.Status | undefined) =>
  error?.code === 6 ||
  (error?.message ?? "").toUpperCase().includes("ALREADY_EXISTS");

const isNotFoundStatus = (error: apim.Status | undefined) =>
  error?.code === 5 ||
  (error?.message ?? "").toLowerCase().includes("not found");

const isIgnorable = (
  error: apim.Status | undefined,
  options?: { notFoundOk?: boolean },
) =>
  alreadyExists(error) ||
  (options?.notFoundOk === true && isNotFoundStatus(error));

export const waitForOperation = (
  operation: apim.Operation,
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
        return yield* new ApimOperationFailed({
          operation: name ?? "",
          message: operation.error.message ?? "operation failed",
        });
      }
      return operation;
    }
    if (name === undefined || name.length === 0) {
      if (options?.notFoundOk === true) return operation;
      return yield* new ApimOperationFailed({
        operation: "",
        message: "operation is missing a name",
      });
    }

    const getOperation = apim.getProjectsLocationsOperations({ name });
    const resolved =
      options?.notFoundOk === true
        ? getOperation.pipe(
            Effect.catchTag("NotFound", () =>
              Effect.succeed<apim.Operation>({
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
        () => new ApimOperationPending({ operation: name }),
      ),
      Effect.filterOrFail(
        (current) => !current.error || isIgnorable(current.error, options),
        (current) =>
          new ApimOperationFailed({
            operation: name,
            message: current.error?.message ?? "operation failed",
          }),
      ),
      Effect.retry({
        while: (error) => error._tag === "GCP.Apim.OperationPending",
        times: options?.times ?? 10,
        schedule: Schedule.spaced(options?.interval ?? "3 seconds"),
      }),
    );
  });

export const waitUntilExists = <A, E, R>(
  get: Effect.Effect<A, E, R>,
  name: string,
): Effect.Effect<A & {}, E | ResourceNotResolved, R> =>
  get.pipe(
    Effect.filterOrFail(
      (value): value is A & {} => value !== undefined,
      () => new ResourceNotResolved({ name }),
    ),
    Effect.retry({
      while: (error) => error instanceof ResourceNotResolved,
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

export const waitUntilGone = <A, E, R>(
  get: Effect.Effect<A, E, R>,
  name: string,
) =>
  get.pipe(
    Effect.filterOrFail(
      (value) => value === undefined,
      () => new ResourceStillExists({ name }),
    ),
    Effect.retry({
      while: (error) => error instanceof ResourceStillExists,
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
    Effect.asVoid,
  );

const FAILED_STATES = new Set(["ERROR", "FAILED"]);

export const waitUntilReady = <A, E, R>(
  get: Effect.Effect<A, E, R>,
  name: string,
  stateOf: (value: A & {}) => string | undefined,
  ready: ReadonlySet<string>,
  options?: {
    times?: number;
    interval?: `${number} seconds`;
  },
): Effect.Effect<
  A & {},
  E | ResourceNotResolved | ResourceNotReady | ResourceFailed,
  R
> =>
  get.pipe(
    Effect.filterOrFail(
      (value): value is A & {} => value !== undefined,
      () => new ResourceNotResolved({ name }),
    ),
    Effect.filterOrFail(
      (value) => !FAILED_STATES.has((stateOf(value) ?? "").toUpperCase()),
      (value) =>
        new ResourceFailed({
          name,
          state: (stateOf(value) ?? "").toUpperCase(),
        }),
    ),
    Effect.filterOrFail(
      (value) => ready.has((stateOf(value) ?? "").toUpperCase()),
      (value) =>
        new ResourceNotReady({
          name,
          state: (stateOf(value) ?? "").toUpperCase(),
        }),
    ),
    Effect.retry({
      while: (error) =>
        error instanceof ResourceNotReady ||
        error instanceof ResourceNotResolved,
      times: options?.times ?? 10,
      schedule: Schedule.spaced(options?.interval ?? "3 seconds"),
    }),
  );

export const collectPages = <Page, A, E, R>(
  pages: Stream.Stream<Page, E, R>,
  items: (page: Page) => readonly A[] | undefined,
) =>
  pages.pipe(
    Stream.flatMap((page) => Stream.fromIterable(items(page) ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  );

export const listAtLocation = <A, E, R>(
  project: string,
  list: (parent: string) => Effect.Effect<A[], E, R>,
) =>
  list(`projects/${project}/locations/-`).pipe(
    Effect.catch(() =>
      list(`projects/${project}/locations/${DEFAULT_LOCATION}`).pipe(
        Effect.orElseSucceed((): A[] => []),
      ),
    ),
  );
