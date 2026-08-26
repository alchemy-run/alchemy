import * as registry from "@distilled.cloud/gcp/agentregistry_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import { alchemyLabelKeys, hasAlchemyLabels } from "../Labels.ts";

export const DEFAULT_LOCATION = "us-central1";
export const MAX_ID_LENGTH = 63;
export const MAX_DESCRIPTION_LENGTH = 2048;
export const MAX_DISPLAY_NAME_LENGTH = 63;

export class AgentregistryOperationFailed extends Data.TaggedError(
  "GCP.Agentregistry.OperationFailed",
)<{
  operation: string;
  message: string;
}> {}

export class AgentregistryOperationPending extends Data.TaggedError(
  "GCP.Agentregistry.OperationPending",
)<{
  operation: string;
}> {}

export class ResourceNotResolved extends Data.TaggedError(
  "GCP.Agentregistry.NotResolved",
)<{
  name: string;
}> {}

export class ResourcePending extends Data.TaggedError(
  "GCP.Agentregistry.Pending",
)<{
  name: string;
}> {}

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const rfc1035 = (name: string, fallback = "bind"): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `${fallback[0] ?? "b"}${next}`;
  next = next.slice(0, MAX_ID_LENGTH).replace(/-+$/g, "");
  if (next.length === 0) return fallback;
  if (!/[a-z0-9]$/.test(next)) next = `${next.slice(0, MAX_ID_LENGTH - 1)}0`;
  if (next.length < 4) next = `${next}xxxx`.slice(0, 4);
  return next.slice(0, MAX_ID_LENGTH);
};

export const normalizeLocation = (location: string | undefined) =>
  lastSegment(location ?? DEFAULT_LOCATION).toLowerCase();

export const locationParent = (project: string, location: string) =>
  `projects/${project}/locations/${normalizeLocation(location)}`;

export const resourceName = (
  project: string,
  location: string,
  collection: string,
  id: string,
) => `${locationParent(project, location)}/${collection}/${id}`;

export const parseResourceName = (name: string, collection: string) => {
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

export const toPhysicalId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
  fallback = "bind",
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return rfc1035(explicit, fallback);
    if (existing !== undefined) return existing;
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength: MAX_ID_LENGTH,
        lowercase: true,
      }),
      fallback,
    );
  });

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

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

export const updateMaskOf = (...fields: Array<string | undefined>) =>
  fields.filter((field): field is string => field !== undefined).join(",");

export const replaceOnIdentity = (input: {
  previousId?: string;
  nextId?: string;
  previousLocation?: string;
  nextLocation?: string;
  extra?: boolean;
}) => {
  const idChanged =
    input.previousId !== undefined &&
    input.nextId !== undefined &&
    input.previousId !== input.nextId;
  const locationChanged =
    (input.previousLocation ?? "") !== "" &&
    (input.nextLocation ?? "") !== "" &&
    (input.previousLocation ?? "") !== (input.nextLocation ?? "");
  if (!idChanged && !locationChanged && input.extra !== true) {
    return undefined;
  }
  const samePhysical =
    !locationChanged &&
    input.previousId !== undefined &&
    input.nextId === input.previousId;
  return {
    action: "replace" as const,
    deleteFirst: samePhysical,
  };
};

const markerOf = (stack: string, stage: string, id: string) =>
  `[alchemy ${alchemyLabelKeys.stack}=${stack} ${alchemyLabelKeys.stage}=${stage} ${alchemyLabelKeys.id}=${id}]`;

export const encodeOwnership = (
  labels: Record<string, string>,
  description: string | undefined,
): string => {
  const marker = markerOf(
    labels[alchemyLabelKeys.stack] ?? "x",
    labels[alchemyLabelKeys.stage] ?? "x",
    labels[alchemyLabelKeys.id] ?? "x",
  ).slice(0, MAX_DESCRIPTION_LENGTH);
  const trimmed = description?.trim();
  if (!trimmed) return marker;
  return `${marker}\n${trimmed}`.slice(0, MAX_DESCRIPTION_LENGTH);
};

export const parseOwnership = (
  description: string | undefined,
): {
  labels: Record<string, string>;
  description: string | undefined;
} => {
  if (!description?.startsWith("[alchemy ")) {
    return { labels: {}, description };
  }
  const end = description.indexOf("]");
  if (end < 0) return { labels: {}, description };
  const labels: Record<string, string> = {};
  for (const part of description.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const rest = description.slice(end + 1).replace(/^\n/, "");
  return { labels, description: rest.length > 0 ? rest : undefined };
};

export const hasOwnershipMarker = (description: string | undefined) =>
  Object.keys(parseOwnership(description).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

export const ownedByAlchemy = (id: string, description: string | undefined) =>
  Effect.gen(function* () {
    const { labels } = parseOwnership(description);
    if (!hasOwnershipMarker(description)) return false;
    return yield* hasAlchemyLabels(id, labels);
  });

export const retryTransient = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: (error) => error._tag === "UnknownGCPError",
      times: 8,
      schedule: Schedule.exponential("250 millis"),
    }),
  );

const alreadyExists = (error: registry.Status | undefined) =>
  error?.code === 6 ||
  (error?.message ?? "").toUpperCase().includes("ALREADY_EXISTS");

const isNotFoundStatus = (error: registry.Status | undefined) =>
  error?.code === 5 ||
  (error?.message ?? "").toLowerCase().includes("not found");

const isIgnorable = (
  error: registry.Status | undefined,
  options?: { notFoundOk?: boolean },
) =>
  alreadyExists(error) ||
  (options?.notFoundOk === true && isNotFoundStatus(error));

export const waitForOperation = (
  operation: registry.Operation,
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
        return yield* new AgentregistryOperationFailed({
          operation: name ?? "",
          message: operation.error.message ?? "operation failed",
        });
      }
      return operation;
    }
    if (name === undefined || name.length === 0) {
      if (options?.notFoundOk === true) return operation;
      return yield* new AgentregistryOperationFailed({
        operation: "",
        message: "operation is missing a name",
      });
    }

    const getOperation = registry.getProjectsLocationsOperations({ name });
    const resolved =
      options?.notFoundOk === true
        ? getOperation.pipe(
            Effect.catchTag("NotFound", () =>
              Effect.succeed<registry.Operation>({
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
        () => new AgentregistryOperationPending({ operation: name }),
      ),
      Effect.filterOrFail(
        (current) => !current.error || isIgnorable(current.error, options),
        (current) =>
          new AgentregistryOperationFailed({
            operation: name,
            message: current.error?.message ?? "operation failed",
          }),
      ),
      Effect.retry({
        while: (error) => error instanceof AgentregistryOperationPending,
        times: options?.times ?? 10,
        schedule: Schedule.spaced(options?.interval ?? "3 seconds"),
      }),
    );
  });

export const waitForVisible = <A, E, R>(
  get: Effect.Effect<A | undefined, E, R>,
) =>
  get.pipe(
    Effect.filterOrFail(
      (value): value is A => value !== undefined,
      () => new ResourcePending({ name: "" }),
    ),
    Effect.retry({
      while: (error) => error instanceof ResourcePending,
      times: 8,
      schedule: Schedule.exponential("250 millis"),
    }),
    Effect.catchIf(
      (error): error is ResourcePending => error instanceof ResourcePending,
      () => Effect.succeed(undefined),
    ),
  );

export const waitUntilGone = <A, E, R>(
  get: Effect.Effect<A | undefined, E, R>,
) =>
  get.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (value) => value === undefined,
      times: 10,
    }),
    Effect.asVoid,
  );

const emptyList = <A>() => Effect.succeed<A[]>([]);

export const collectPages = <
  Page,
  Item,
  E extends { readonly _tag: string },
  R,
>(
  pages: Stream.Stream<Page, E, R>,
  items: (page: Page) => readonly Item[] | null | undefined,
) =>
  pages.pipe(
    Stream.flatMap((page) => Stream.fromIterable(items(page) ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk) as Item[]),
  );

const listAt = (parent: string) =>
  parent.length === 0
    ? emptyList<registry.Binding>()
    : collectPages(
        registry.listProjectsLocationsBindings.pages({
          parent,
          pageSize: 500,
        }),
        (page) => page.bindings,
      ).pipe(
        Effect.catchTag(["NotFound", "Forbidden"], () =>
          emptyList<registry.Binding>(),
        ),
      );

export const listBindings = (project: string) =>
  listAt(`projects/${project}/locations/-`).pipe(
    Effect.flatMap((items) =>
      items.length > 0
        ? Effect.succeed(items)
        : Effect.all([
            listAt(locationParent(project, DEFAULT_LOCATION)),
            listAt(locationParent(project, "global")),
          ]).pipe(Effect.map((groups) => groups.flat())),
    ),
  );
