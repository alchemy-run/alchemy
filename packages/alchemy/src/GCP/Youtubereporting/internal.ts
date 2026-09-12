import * as youtubereporting from "@distilled.cloud/gcp/youtubereporting_v1";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";

export const MAX_NAME_LENGTH = 100;
export const DEFAULT_REPORT_TYPE_ID = "channel_basic_a2";
export const PROBE_JOB_ID = "0";

const markerOf = (stack: string, stage: string, id: string) =>
  `[alchemy ${alchemyLabelKeys.stack}=${stack} ${alchemyLabelKeys.stage}=${stage} ${alchemyLabelKeys.id}=${id}]`;

export const fitMarker = (
  labels: Record<string, string>,
  maxLength: number,
) => {
  let stack = labels[alchemyLabelKeys.stack] ?? "x";
  let stage = labels[alchemyLabelKeys.stage] ?? "x";
  let id = labels[alchemyLabelKeys.id] ?? "x";
  let marker = markerOf(stack, stage, id);
  while (
    marker.length > maxLength &&
    (stack.length > 1 || stage.length > 1 || id.length > 1)
  ) {
    if (id.length >= stack.length && id.length >= stage.length) {
      id = id.slice(0, -1);
    } else if (stack.length >= stage.length) {
      stack = stack.slice(0, -1);
    } else {
      stage = stage.slice(0, -1);
    }
    marker = markerOf(stack, stage, id);
  }
  return marker.slice(0, maxLength);
};

export const encodeName = (
  labels: Record<string, string>,
  name: string | undefined,
  maxLength = MAX_NAME_LENGTH,
): string => {
  const trimmed = name?.replace(/[\r\n]+/g, " ").trim();
  if (!trimmed) return fitMarker(labels, maxLength);
  const minMarker = 24;
  const reserved = Math.min(
    trimmed.length + 1,
    Math.max(0, maxLength - minMarker),
  );
  const marker = fitMarker(labels, maxLength - reserved);
  return `${marker} ${trimmed}`.slice(0, maxLength);
};

export const parseName = (
  name: string | undefined,
): {
  labels: Record<string, string>;
  name: string | undefined;
} => {
  if (!name?.startsWith("[alchemy ")) {
    return { labels: {}, name };
  }
  const end = name.indexOf("]");
  if (end < 0) return { labels: {}, name };
  const labels: Record<string, string> = {};
  for (const part of name.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const rest = name.slice(end + 1).replace(/^[\s\n]+/, "");
  return { labels, name: rest.length > 0 ? rest : undefined };
};

export const hasOwnershipMarker = (name: string | undefined) =>
  Object.keys(parseName(name).labels).some((key) => key.startsWith("alchemy-"));

const prefixMatch = (expected: string, observed: string) =>
  expected === observed ||
  expected.startsWith(observed) ||
  observed.startsWith(expected);

export const ownedByAlchemy = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    const expected = yield* createInternalLabels(id);
    const { labels } = parseName(name);
    if (!hasOwnershipMarker(name)) return false;
    if (yield* hasAlchemyLabels(id, labels)) return true;
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

export const ownershipLabels = (id: string) => createInternalLabels(id);

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const toDisplayName = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (requested !== undefined && requested.length > 0) return requested;
    if (existing !== undefined && existing.length > 0) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: 40,
      lowercase: true,
    });
    return /^[a-z]/.test(generated) ? generated : `j${generated}`.slice(0, 40);
  });

export const ownedName = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    const labels = yield* ownershipLabels(id);
    const user = yield* toDisplayName(id, requested, existing);
    return encodeName(labels, user);
  });

export const ignoreMissing = <E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<unknown, E, R>,
) =>
  effect.pipe(
    Effect.catchIf(
      (error): error is E & { readonly _tag: "NotFound" | "Forbidden" } =>
        error._tag === "NotFound" || error._tag === "Forbidden",
      () => Effect.void,
    ),
  );

const emptyList = <A>() => Effect.succeed([] as A[]);

export const getJob = (
  jobId: string | undefined,
  onBehalfOfContentOwner?: string,
) =>
  !jobId
    ? Effect.succeed(undefined)
    : youtubereporting
        .getJobs({
          jobId,
          onBehalfOfContentOwner,
        })
        .pipe(
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          Effect.catchTag("Forbidden", () => Effect.succeed(undefined)),
        );

export const listJobs = (onBehalfOfContentOwner?: string) =>
  youtubereporting.listJobs
    .pages({
      pageSize: 100,
      includeSystemManaged: false,
      onBehalfOfContentOwner,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.jobs ?? [])),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => emptyList<youtubereporting.Job>()),
      Effect.catchTag("Forbidden", () => emptyList<youtubereporting.Job>()),
    );

export const listOwnedJobs = (onBehalfOfContentOwner?: string) =>
  listJobs(onBehalfOfContentOwner).pipe(
    Effect.map((rows) => rows.filter((row) => hasOwnershipMarker(row.name))),
  );

export const findOwnedJob = (id: string, onBehalfOfContentOwner?: string) =>
  Effect.gen(function* () {
    const rows = yield* listOwnedJobs(onBehalfOfContentOwner);
    for (const row of rows) {
      if (yield* ownedByAlchemy(id, row.name)) {
        return row;
      }
    }
    return undefined;
  });
