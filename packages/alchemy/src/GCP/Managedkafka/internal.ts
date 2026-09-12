import * as kafka from "@distilled.cloud/gcp/managedkafka_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import { tagRecord } from "../../Tags.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  stripInternalLabels,
} from "../Labels.ts";

export const DEFAULT_LOCATION = "us-central1";
export const MAX_NAME_LENGTH = 63;
export const DEFAULT_VCPU_COUNT = 3;
export const DEFAULT_MEMORY_BYTES = 3_221_225_472;
export const OWNERSHIP_SUBJECT = "alchemy_ownership";

export class ManagedKafkaOperationFailed extends Data.TaggedError(
  "GCP.Managedkafka.OperationFailed",
)<{
  operation: string;
  message: string;
}> {}

export class ManagedKafkaOperationPending extends Data.TaggedError(
  "GCP.Managedkafka.OperationPending",
)<{
  operation: string;
}> {}

export class ResourceNotResolved extends Data.TaggedError(
  "GCP.Managedkafka.ResourceNotResolved",
)<{
  name: string;
}> {}

export class ResourceStillExists extends Data.TaggedError(
  "GCP.Managedkafka.ResourceStillExists",
)<{
  name: string;
}> {}

export class ResourceNotReady extends Data.TaggedError(
  "GCP.Managedkafka.ResourceNotReady",
)<{
  name: string;
  state: string;
}> {}

export class ResourceFailed extends Data.TaggedError(
  "GCP.Managedkafka.ResourceFailed",
)<{
  name: string;
  state: string;
}> {}

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const rfc1035 = (name: string, fallback = "kafka"): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `k${next}`;
  next = next.slice(0, MAX_NAME_LENGTH).replace(/-+$/g, "");
  if (next.length === 0) return fallback;
  if (!/[a-z0-9]$/.test(next)) next = `${next.slice(0, MAX_NAME_LENGTH - 1)}0`;
  return next.slice(0, MAX_NAME_LENGTH);
};

export const schemaRegistryIdOf = (
  name: string,
  fallback = "schema",
): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  if (!/^[a-z]/.test(next)) next = `s${next}`;
  next = next.slice(0, MAX_NAME_LENGTH).replace(/_+$/g, "");
  return next.length > 0 ? next : fallback;
};

export const normalizeLocation = (location: string | undefined) =>
  lastSegment(location ?? DEFAULT_LOCATION).toLowerCase();

export const locationParent = (project: string, location: string) =>
  `projects/${project}/locations/${location}`;

export const defaultSubnet = (project: string, location: string) =>
  `projects/${project}/regions/${location}/subnetworks/default`;

export const toPhysicalId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
  fallback = "kafka",
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

export const toSchemaRegistryId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return schemaRegistryIdOf(explicit);
    if (existing !== undefined) return existing;
    return schemaRegistryIdOf(
      yield* createPhysicalName({
        id,
        maxLength: MAX_NAME_LENGTH,
        lowercase: true,
        delimiter: "_",
      }),
    );
  });

export const toSubjectId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return explicit;
    if (existing !== undefined) return existing;
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength: MAX_NAME_LENGTH,
        lowercase: true,
      }),
      "subject",
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
        : DEFAULT_LOCATION,
    id:
      collectionAt >= 0 && parts[collectionAt + 1]
        ? parts.slice(collectionAt + 1).join("/")
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

export const stringMapOf = (
  value: Record<string, string | undefined> | null | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(value ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const fingerprint = (value: unknown): string =>
  JSON.stringify(value ?? null);

export const fieldMask = (fields: Array<string | false | undefined>) =>
  fields
    .filter((field): field is string => typeof field === "string")
    .join(",");

export const asCount = (
  value: number | string | undefined,
  fallback: number,
) => {
  if (value === undefined) return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const asCountString = (
  value: number | string | undefined,
  fallback: number,
) => String(asCount(value, fallback));

export const replaceOnIdentity = (input: {
  previousId?: string;
  nextId?: string;
  previousLocation?: string;
  nextLocation?: string;
  previousParent?: string;
  nextParent?: string;
  extra?: boolean;
}) => {
  const parentChanged =
    (input.previousParent ?? "") !== "" &&
    (input.nextParent ?? "") !== "" &&
    (input.previousParent ?? "") !== (input.nextParent ?? "");
  const locationChanged =
    (input.previousLocation ?? "") !== "" &&
    (input.nextLocation ?? "") !== "" &&
    (input.previousLocation ?? "") !== (input.nextLocation ?? "");
  const idChanged =
    input.previousId !== undefined &&
    input.nextId !== undefined &&
    input.previousId !== input.nextId;
  if (
    !(input.extra === true || parentChanged || locationChanged || idChanged)
  ) {
    return undefined;
  }
  const samePhysical =
    !parentChanged &&
    !locationChanged &&
    input.previousId !== undefined &&
    input.nextId === input.previousId;
  return {
    action: "replace" as const,
    deleteFirst: samePhysical,
  };
};

const READY_STATES = new Set(["ACTIVE", "RUNNING"]);
const FAILED_STATES = new Set(["FAILED", "ERROR"]);

export const isReadyState = (state: string | undefined) =>
  READY_STATES.has((state ?? "").toUpperCase());

export const isFailedState = (state: string | undefined) =>
  FAILED_STATES.has((state ?? "").toUpperCase());

const alreadyExists = (error: kafka.Status | undefined) =>
  error?.code === 6 ||
  (error?.message ?? "").toUpperCase().includes("ALREADY_EXISTS");

const isNotFoundStatus = (error: kafka.Status | undefined) =>
  error?.code === 5 ||
  (error?.message ?? "").toLowerCase().includes("not found");

const isIgnorable = (
  error: kafka.Status | undefined,
  options?: { notFoundOk?: boolean },
) =>
  alreadyExists(error) ||
  (options?.notFoundOk === true && isNotFoundStatus(error));

export const waitForOperation = (
  operation: kafka.Operation,
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
        return yield* new ManagedKafkaOperationFailed({
          operation: name ?? "",
          message: operation.error.message ?? "operation failed",
        });
      }
      return operation;
    }
    if (name === undefined || name.length === 0) {
      if (options?.notFoundOk === true) return operation;
      return yield* new ManagedKafkaOperationFailed({
        operation: "",
        message: "operation is missing a name",
      });
    }

    const getOperation = kafka.getProjectsLocationsOperations({ name });
    const resolved =
      options?.notFoundOk === true
        ? getOperation.pipe(
            Effect.catchTag("NotFound", () =>
              Effect.succeed<kafka.Operation>({
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
        () => new ManagedKafkaOperationPending({ operation: name }),
      ),
      Effect.flatMap((current) => {
        const error = current.error;
        if (error && !isIgnorable(error, options)) {
          return Effect.fail(
            new ManagedKafkaOperationFailed({
              operation: name,
              message: error.message ?? "operation failed",
            }),
          );
        }
        return Effect.succeed(current);
      }),
      Effect.retry({
        while: (error) => error._tag === "GCP.Managedkafka.OperationPending",
        times: options?.times ?? 10,
        schedule: Schedule.spaced(options?.interval ?? "8 seconds"),
      }),
    );
  });

export const waitUntilExists = <A, E extends { readonly _tag: string }, R>(
  get: Effect.Effect<A | undefined, E, R>,
  name: string,
) =>
  get.pipe(
    Effect.filterOrFail(
      (value): value is A => value !== undefined,
      () => new ResourceNotResolved({ name }),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Managedkafka.ResourceNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

export const waitUntilGone = <A, E extends { readonly _tag: string }, R>(
  get: Effect.Effect<A | undefined, E, R>,
  name: string,
) =>
  get.pipe(
    Effect.flatMap((value) =>
      value === undefined
        ? Effect.void
        : Effect.fail(new ResourceStillExists({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Managedkafka.ResourceStillExists",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

export const waitUntilReady = <A, E extends { readonly _tag: string }, R>(
  get: Effect.Effect<A | undefined, E, R>,
  name: string,
  stateOf: (value: A) => string | undefined,
) =>
  get.pipe(
    Effect.filterOrFail(
      (value): value is A => value !== undefined,
      () => new ResourceNotResolved({ name }),
    ),
    Effect.filterOrFail(
      (value) => !isFailedState(stateOf(value) ?? ""),
      (value) => new ResourceFailed({ name, state: stateOf(value) ?? "" }),
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
        error._tag === "GCP.Managedkafka.ResourceNotReady" ||
        error._tag === "GCP.Managedkafka.ResourceNotResolved",
      times: 10,
      schedule: Schedule.spaced("8 seconds"),
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
      list(`projects/${project}/locations/${DEFAULT_LOCATION}`),
    ),
    Effect.orElseSucceed(() => [] as A[]),
  );

export const listClusters = (project: string) =>
  listAtLocation(project, (parent) =>
    collectPages(
      kafka.listProjectsLocationsClusters.pages({ parent, pageSize: 1000 }),
      (page) => page.clusters,
    ).pipe(
      Effect.catchTag("NotFound", () => Effect.succeed([] as kafka.Cluster[])),
      Effect.catchTag("Forbidden", () => Effect.succeed([] as kafka.Cluster[])),
    ),
  );

export const listAlchemyClusters = (project: string) =>
  listClusters(project).pipe(
    Effect.map((clusters: kafka.Cluster[]) =>
      clusters.filter((cluster) => hasAlchemyLabelMap(cluster.labels)),
    ),
  );

export const listConnectClusters = (project: string) =>
  listAtLocation(project, (parent) =>
    collectPages(
      kafka.listProjectsLocationsConnectClusters.pages({
        parent,
        pageSize: 1000,
      }),
      (page) => page.connectClusters,
    ).pipe(
      Effect.catchTag("NotFound", () =>
        Effect.succeed([] as kafka.ConnectCluster[]),
      ),
      Effect.catchTag("Forbidden", () =>
        Effect.succeed([] as kafka.ConnectCluster[]),
      ),
    ),
  );

export const listAlchemyConnectClusters = (project: string) =>
  listConnectClusters(project).pipe(
    Effect.map((clusters: kafka.ConnectCluster[]) =>
      clusters.filter((cluster) => hasAlchemyLabelMap(cluster.labels)),
    ),
  );

export const listSchemaRegistries = (project: string, location?: string) => {
  const parents = [
    `projects/${project}/locations/${location ?? DEFAULT_LOCATION}`,
    `projects/${project}/locations/-`,
  ];
  return Effect.forEach(
    parents,
    (parent) =>
      kafka
        .listProjectsLocationsSchemaRegistries({
          parent,
          view: "SCHEMA_REGISTRY_VIEW_FULL",
        })
        .pipe(
          Effect.map((page) => page.schemaRegistries ?? []),
          Effect.catchTag("NotFound", () =>
            Effect.succeed([] as kafka.SchemaRegistry[]),
          ),
          Effect.catchTag("Forbidden", () =>
            Effect.succeed([] as kafka.SchemaRegistry[]),
          ),
        ),
    { concurrency: 1 },
  ).pipe(
    Effect.map((groups) => {
      const seen = new Set<string>();
      const out: kafka.SchemaRegistry[] = [];
      for (const registry of groups.flat()) {
        const name = registry.name ?? "";
        if (name.length === 0 || seen.has(name)) continue;
        seen.add(name);
        out.push(registry);
      }
      return out;
    }),
  );
};

export const encodeOwnership = (labels: Record<string, string>) =>
  `[alchemy ${alchemyLabelKeys.stack}=${labels[alchemyLabelKeys.stack]} ${alchemyLabelKeys.stage}=${labels[alchemyLabelKeys.stage]} ${alchemyLabelKeys.id}=${labels[alchemyLabelKeys.id]}]`;

export const parseOwnership = (text: string | undefined) => {
  if (!text?.includes("[alchemy ")) return {} as Record<string, string>;
  const start = text.indexOf("[alchemy ");
  const end = text.indexOf("]", start);
  if (end < 0) return {} as Record<string, string>;
  const labels: Record<string, string> = {};
  for (const part of text.slice(start + "[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) labels[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return labels;
};

export const hasOwnershipMarker = (text: string | undefined) =>
  Object.keys(parseOwnership(text)).some((key) => key.startsWith("alchemy-"));

export const ownershipSchema = (labels: Record<string, string>) =>
  JSON.stringify({
    type: "record",
    name: "AlchemyOwnership",
    namespace: "alchemy",
    doc: encodeOwnership(labels),
    fields: [{ name: "ok", type: "string" }],
  });

export const parseHttpJson = (body: kafka.HttpBody | undefined) =>
  Effect.sync(() => {
    const data = body?.data;
    if (data === undefined || data.length === 0) return undefined;
    try {
      return JSON.parse(data) as unknown;
    } catch {
      /* base64 */
    }
    try {
      return JSON.parse(
        Buffer.from(data, "base64").toString("utf8"),
      ) as unknown;
    } catch {
      return undefined;
    }
  });

export const subjectParent = (
  schemaRegistry: string,
  subject: string,
  context?: string,
) =>
  context !== undefined && context.length > 0
    ? `${schemaRegistry}/contexts/${context}/subjects/${subject}`
    : `${schemaRegistry}/subjects/${subject}`;

export const versionName = (parent: string, version: number | string) =>
  `${parent}/versions/${version}`;

export const retryTransient = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: (error) =>
        error._tag === "TooManyRequests" ||
        error._tag === "NotFound" ||
        error._tag === "UnknownGCPError",
      times: 8,
      schedule: Schedule.exponential("250 millis"),
    }),
  );

export const getCluster = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : kafka
        .getProjectsLocationsClusters({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const getConnectCluster = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : kafka
        .getProjectsLocationsConnectClusters({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const getAcl = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : kafka
        .getProjectsLocationsClustersAcls({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const getTopic = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : kafka
        .getProjectsLocationsClustersTopics({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const getConnector = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : kafka
        .getProjectsLocationsConnectClustersConnectors({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const getSchemaRegistry = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : kafka
        .getProjectsLocationsSchemaRegistries({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const getSchemaVersion = (name: string, deleted = false) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : kafka
        .getProjectsLocationsSchemaRegistriesSubjectsVersions({
          name,
          deleted,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const getContextSchemaVersion = (name: string, deleted = false) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : kafka
        .getProjectsLocationsSchemaRegistriesContextsSubjectsVersions({
          name,
          deleted,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const stampSchemaRegistryOwnership = (
  schemaRegistry: string,
  labels: Record<string, string>,
) =>
  Effect.gen(function* () {
    const parent = subjectParent(schemaRegistry, OWNERSHIP_SUBJECT);
    const schema = ownershipSchema(labels);
    const latest = yield* getSchemaVersion(versionName(parent, "latest"));
    if (hasOwnershipMarker(latest?.schema) && latest?.schema === schema) {
      return;
    }
    yield* kafka
      .createProjectsLocationsSchemaRegistriesSubjectsVersions({
        parent,
        body: {
          schemaType: "AVRO",
          schema,
        },
      })
      .pipe(Effect.catchTag(["Conflict", "BadRequest"], () => Effect.void));
  });

export const schemaRegistryOwnership = (schemaRegistry: string) =>
  getSchemaVersion(
    versionName(subjectParent(schemaRegistry, OWNERSHIP_SUBJECT), "latest"),
  ).pipe(Effect.map((version) => parseOwnership(version?.schema)));

export const hasSchemaRegistryOwnership = Effect.fn(function* (
  id: string,
  schemaRegistry: string,
) {
  const expected = yield* createInternalLabels(id);
  const observed = yield* schemaRegistryOwnership(schemaRegistry);
  return (
    observed[alchemyLabelKeys.stack] === expected[alchemyLabelKeys.stack] &&
    observed[alchemyLabelKeys.stage] === expected[alchemyLabelKeys.stage] &&
    observed[alchemyLabelKeys.id] === expected[alchemyLabelKeys.id]
  );
});
