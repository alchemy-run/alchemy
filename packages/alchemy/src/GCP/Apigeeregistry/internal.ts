import { createHash } from "node:crypto";
import * as registry from "@distilled.cloud/gcp/apigeeregistry_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import { tagRecord } from "../../Tags.ts";
import {
  createInternalLabels,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";

export const DEFAULT_LOCATION = "us-central1";
export const MAX_ID_LENGTH = 63;

export class RegistryNotResolved extends Data.TaggedError(
  "GCP.Apigeeregistry.ResourceNotResolved",
)<{
  name: string;
}> {}

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const locationParent = (project: string, location: string) =>
  `projects/${project}/locations/${location}`;

export const normalizeLocation = (location: string | undefined) =>
  lastSegment(location ?? DEFAULT_LOCATION).toLowerCase();

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

export const expandParent = (
  value: string,
  project: string,
  location: string,
  collection: string,
) => {
  if (value.includes("/")) return value.replace(/\/+$/, "");
  return `projects/${project}/locations/${location}/${collection}/${value}`;
};

export const rfc1035 = (name: string, maxLength = MAX_ID_LENGTH): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `a${next}`;
  next = next.slice(0, maxLength).replace(/-+$/g, "");
  if (next.length === 0) return "registry";
  if (next.length < 4) next = `${next}xxxx`.slice(0, maxLength);
  if (!/[a-z0-9]$/.test(next)) next = `${next.slice(0, maxLength - 1)}0`;
  return next.slice(0, maxLength);
};

export const toPhysicalId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
  maxLength = MAX_ID_LENGTH,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return explicit;
    if (existing !== undefined) return existing;
    return rfc1035(
      yield* createPhysicalName({ id, maxLength, lowercase: true }),
      maxLength,
    );
  });

export const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

export const hasAlchemyLabelMap = (
  labels: Record<string, string | undefined> | null | undefined,
) => Object.keys(labels ?? {}).some((key) => key.startsWith("alchemy-"));

export const annotationsOf = (
  annotations: Record<string, string | undefined> | null | undefined,
): Record<string, string> => tagRecord(annotations);

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
  previousParent?: string;
  nextParent?: string;
  previousLocation?: string;
  nextLocation?: string;
}) => {
  const idChanged =
    input.previousId !== undefined &&
    input.nextId !== undefined &&
    input.previousId !== input.nextId;
  const parentChanged =
    (input.previousParent ?? "") !== "" &&
    (input.nextParent ?? "") !== "" &&
    (input.previousParent ?? "") !== (input.nextParent ?? "");
  const locationChanged =
    (input.previousLocation ?? "") !== "" &&
    (input.nextLocation ?? "") !== "" &&
    (input.previousLocation ?? "") !== (input.nextLocation ?? "");
  if (!idChanged && !parentChanged && !locationChanged) return undefined;
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

export const encodeBytes = (contents: string) =>
  Effect.sync(() => Buffer.from(contents, "utf8").toString("base64"));

export const decodeBytes = (value: string | undefined) =>
  Effect.sync(() => {
    if (value === undefined || value.length === 0) return undefined;
    return Buffer.from(value, "base64").toString("utf8");
  });

export const sha256Hex = (value: string) =>
  Effect.sync(() =>
    createHash("sha256").update(value, "utf8").digest("hex").toLowerCase(),
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
    Effect.map((chunk) => Array.from(chunk)),
    Effect.catchIf(
      (
        error,
      ): error is E & {
        readonly _tag: "NotFound" | "Forbidden" | "InternalServerError";
      } =>
        error._tag === "NotFound" ||
        error._tag === "Forbidden" ||
        error._tag === "InternalServerError",
      () => emptyList<Item>(),
    ),
  );

export const listApis = (parent: string) =>
  parent.length === 0
    ? emptyList<registry.Api>()
    : collectPages(
        registry.listProjectsLocationsApis.pages({ parent, pageSize: 1000 }),
        (page) => page.apis,
      );

export const listVersions = (parent: string) =>
  parent.length === 0
    ? emptyList<registry.ApiVersion>()
    : collectPages(
        registry.listProjectsLocationsApisVersions.pages({
          parent,
          pageSize: 1000,
        }),
        (page) => page.apiVersions,
      );

export const listDeployments = (parent: string) =>
  parent.length === 0
    ? emptyList<registry.ApiDeployment>()
    : collectPages(
        registry.listProjectsLocationsApisDeployments.pages({
          parent,
          pageSize: 1000,
        }),
        (page) => page.apiDeployments,
      );

export const listSpecs = (parent: string) =>
  parent.length === 0
    ? emptyList<registry.ApiSpec>()
    : collectPages(
        registry.listProjectsLocationsApisVersionsSpecs.pages({
          parent,
          pageSize: 1000,
        }),
        (page) => page.apiSpecs,
      );

export const listChildResources = <A, E, R>(
  parents: readonly { name?: string }[],
  list: (name: string) => Effect.Effect<A[], E, R>,
) =>
  Effect.forEach(
    parents.filter((parent) => (parent.name ?? "").length > 0),
    (parent) => list(parent.name!),
    { concurrency: 4 },
  ).pipe(Effect.map((groups) => groups.flat()));

export const listByParentNames = <A, E, R>(
  parents: readonly string[],
  list: (name: string) => Effect.Effect<A[], E, R>,
) =>
  Effect.forEach(
    parents.filter((parent) => parent.length > 0),
    (parent) => list(parent),
    { concurrency: 4 },
  ).pipe(Effect.map((groups) => groups.flat()));

export const namedOf = <T extends { name?: string }>(items: readonly T[]) =>
  items.filter((item) => (item.name ?? "").length > 0);

export const locationArtifacts = (parent: string) =>
  parent.length === 0
    ? emptyList<registry.Artifact>()
    : collectPages(
        registry.listProjectsLocationsArtifacts.pages({
          parent,
          pageSize: 1000,
        }),
        (page) => page.artifacts,
      );

export const apiArtifacts = (parent: string) =>
  parent.length === 0
    ? emptyList<registry.Artifact>()
    : collectPages(
        registry.listProjectsLocationsApisArtifacts.pages({
          parent,
          pageSize: 1000,
        }),
        (page) => page.artifacts,
      );

export const deploymentArtifacts = (parent: string) =>
  parent.length === 0
    ? emptyList<registry.Artifact>()
    : collectPages(
        registry.listProjectsLocationsApisDeploymentsArtifacts.pages({
          parent,
          pageSize: 1000,
        }),
        (page) => page.artifacts,
      );

export const versionArtifacts = (parent: string) =>
  parent.length === 0
    ? emptyList<registry.Artifact>()
    : collectPages(
        registry.listProjectsLocationsApisVersionsArtifacts.pages({
          parent,
          pageSize: 1000,
        }),
        (page) => page.artifacts,
      );

export const specArtifacts = (parent: string) =>
  parent.length === 0
    ? emptyList<registry.Artifact>()
    : collectPages(
        registry.listProjectsLocationsApisVersionsSpecsArtifacts.pages({
          parent,
          pageSize: 1000,
        }),
        (page) => page.artifacts,
      );

export type ArtifactAttrs = {
  name: string;
  artifactId: string;
  parent: string;
  project: string;
  location: string;
  mimeType: string | undefined;
  sizeBytes: number | undefined;
  hash: string | undefined;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  createTime: string | undefined;
  updateTime: string | undefined;
};

export const artifactAttrs = (
  artifact: registry.Artifact,
  project: string,
): ArtifactAttrs => {
  const name = artifact.name ?? "";
  const parsed = parseResourceName(name, "artifacts");
  return {
    name,
    artifactId: parsed.id,
    parent: parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    mimeType: artifact.mimeType,
    sizeBytes: artifact.sizeBytes,
    hash: artifact.hash,
    labels: userLabels(artifact.labels),
    annotations: annotationsOf(artifact.annotations),
    createTime: artifact.createTime,
    updateTime: artifact.updateTime,
  };
};

export type ArtifactNews = {
  mimeType?: string;
  contents?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
};

export type ArtifactOps<E = unknown, R = unknown> = {
  get: (name: string) => Effect.Effect<registry.Artifact | undefined, E, R>;
  create: (input: {
    parent: string;
    artifactId: string;
    body: registry.Artifact;
  }) => Effect.Effect<registry.Artifact | undefined, E, R>;
  replace: (input: {
    name: string;
    body: registry.Artifact;
  }) => Effect.Effect<registry.Artifact, E, R>;
  delete: (name: string) => Effect.Effect<void, E, R>;
  getContents: (name: string) => Effect.Effect<string | undefined, E, R>;
};

export const ignoreGone = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.catchIf(
      (
        error,
      ): error is E & { readonly _tag: "NotFound" | "InternalServerError" } =>
        error._tag === "NotFound" || error._tag === "InternalServerError",
      () => Effect.void,
    ),
  );

export const missingGet =
  <A, E extends { readonly _tag: string }, R>(
    effect: (input: { name: string }) => Effect.Effect<A, E, R>,
  ) =>
  (name: string) =>
    name.length === 0
      ? Effect.succeed(undefined)
      : effect({ name }).pipe(
          Effect.catchIf(
            (error): error is E & { readonly _tag: "NotFound" } =>
              error._tag === "NotFound",
            () => Effect.succeed(undefined),
          ),
        );

export const contentsOf =
  <E extends { readonly _tag: string }, R>(
    get: (input: { name: string }) => Effect.Effect<registry.HttpBody, E, R>,
  ) =>
  (name: string) =>
    name.length === 0
      ? Effect.succeed(undefined)
      : get({ name }).pipe(
          Effect.flatMap((body) => decodeBytes(body.data)),
          Effect.catchIf(
            (error): error is E & { readonly _tag: "NotFound" } =>
              error._tag === "NotFound",
            () => Effect.succeed(undefined),
          ),
        );

export const reconcileArtifact = Effect.fn(function* (input: {
  id: string;
  name: string;
  parent: string;
  artifactId: string;
  news: ArtifactNews;
  ops: ArtifactOps;
}) {
  const desiredLabels = {
    ...toLabels(input.news.labels),
    ...(yield* createInternalLabels(input.id)),
  };
  const desiredAnnotations = tagRecord(input.news.annotations);
  const mimeType = input.news.mimeType ?? "text/plain";

  let current = yield* input.ops.get(input.name);

  const contents =
    input.news.contents !== undefined
      ? yield* encodeBytes(input.news.contents)
      : undefined;

  if (current === undefined) {
    const created = yield* input.ops.create({
      parent: input.parent,
      artifactId: input.artifactId,
      body: {
        mimeType,
        contents,
        labels: desiredLabels,
        annotations: desiredAnnotations,
      },
    });
    current = created ?? undefined;
  }

  if (current === undefined) {
    return yield* new RegistryNotResolved({ name: input.name });
  }

  const currentName = current.name ?? input.name;
  const observedLabels = tagRecord(current.labels);
  const labelsChanged = !sameJson(observedLabels, desiredLabels);
  const annotationsChanged = !sameJson(
    annotationsOf(current.annotations),
    desiredAnnotations,
  );
  const mimeChanged = !sameText(current.mimeType, mimeType);

  let contentsChanged = false;
  let nextContents = contents;
  if (input.news.contents !== undefined) {
    const desiredHash = yield* sha256Hex(input.news.contents);
    contentsChanged = (current.hash ?? "").toLowerCase() !== desiredHash;
  }

  if (
    (labelsChanged || annotationsChanged || mimeChanged) &&
    nextContents === undefined
  ) {
    const existing = yield* input.ops.getContents(currentName);
    if (existing !== undefined) {
      nextContents = yield* encodeBytes(existing);
    }
  }

  if (labelsChanged || annotationsChanged || mimeChanged || contentsChanged) {
    current = yield* input.ops.replace({
      name: currentName,
      body: {
        name: currentName,
        mimeType,
        contents: nextContents,
        labels: desiredLabels,
        annotations: desiredAnnotations,
      },
    });
  }

  return current;
});

export const ownedArtifact = (
  id: string,
  artifact: registry.Artifact,
  project: string,
) =>
  Effect.gen(function* () {
    const attrs = artifactAttrs(artifact, project);
    return (yield* hasAlchemyLabels(id, tagRecord(artifact.labels)))
      ? attrs
      : undefined;
  });
