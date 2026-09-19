import * as firebaseappdistribution from "@distilled.cloud/gcp/firebaseappdistribution_v1";
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

export const MAX_DISPLAY_NAME = 1024;
export const MAX_GROUP_ID = 63;
export const MIN_GROUP_ID = 4;

export class ResourceNotResolved extends Data.TaggedError(
  "GCP.Firebaseappdistribution.ResourceNotResolved",
)<{
  name: string;
}> {}

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const projectParent = (project: string) =>
  project.startsWith("projects/") ? project : `projects/${project}`;

export const groupName = (project: string, groupId: string) =>
  `${projectParent(project)}/groups/${groupId}`;

export const parseGroupName = (
  name: string,
  fallbackProject = "",
): { project: string; groupId: string; parent: string } => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const projectsAt = parts.lastIndexOf("projects");
  const groupsAt = parts.lastIndexOf("groups");
  const project =
    projectsAt >= 0 && parts[projectsAt + 1]
      ? parts[projectsAt + 1]!
      : fallbackProject;
  return {
    project,
    groupId:
      groupsAt >= 0 && parts[groupsAt + 1]
        ? parts[groupsAt + 1]!
        : lastSegment(name),
    parent: project.length > 0 ? projectParent(project) : "",
  };
};

export const groupIdOf = (value: string | undefined) => {
  if (value === undefined) return undefined;
  const trimmed = value.replace(/\/+$/, "").trim();
  if (trimmed.length === 0) return undefined;
  return lastSegment(trimmed);
};

export const sanitizeGroupId = (value: string) => {
  let cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (cleaned.length === 0) cleaned = "group";
  if (!/^[a-z]/.test(cleaned)) cleaned = `g${cleaned}`;
  if (cleaned.length < MIN_GROUP_ID) {
    cleaned = `${cleaned}${"xxxx".slice(0, MIN_GROUP_ID - cleaned.length)}`;
  }
  cleaned = cleaned.slice(0, MAX_GROUP_ID).replace(/-+$/g, "");
  if (cleaned.length < MIN_GROUP_ID) cleaned = "group";
  return cleaned;
};

export const toGroupId = (
  id: string,
  requested: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    const explicit = groupIdOf(requested);
    if (explicit !== undefined) return sanitizeGroupId(explicit);
    const previous = groupIdOf(existing);
    if (previous !== undefined) return sanitizeGroupId(previous);
    const generated = yield* createPhysicalName({
      id,
      maxLength: MAX_GROUP_ID,
      lowercase: true,
    });
    return sanitizeGroupId(generated);
  });

const markerOf = (stack: string, stage: string, id: string) =>
  `[alchemy ${alchemyLabelKeys.stack}=${stack} ${alchemyLabelKeys.stage}=${stage} ${alchemyLabelKeys.id}=${id}]`;

export const encodeDisplayName = (
  labels: Record<string, string>,
  displayName: string | undefined,
): string => {
  const marker = markerOf(
    labels[alchemyLabelKeys.stack] ?? "x",
    labels[alchemyLabelKeys.stage] ?? "x",
    labels[alchemyLabelKeys.id] ?? "x",
  );
  const trimmed = displayName?.replace(/[\r\n]+/g, " ").trim();
  const combined =
    trimmed && trimmed.length > 0 ? `${marker} ${trimmed}` : marker;
  return combined.slice(0, MAX_DISPLAY_NAME);
};

export const parseDisplayName = (
  displayName: string | undefined,
): {
  labels: Record<string, string>;
  displayName: string | undefined;
} => {
  if (!displayName?.startsWith("[alchemy ")) {
    return { labels: {}, displayName };
  }
  const end = displayName.indexOf("]");
  if (end < 0) return { labels: {}, displayName };
  const labels: Record<string, string> = {};
  for (const part of displayName.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const rest = displayName.slice(end + 1).trim();
  return { labels, displayName: rest.length > 0 ? rest : undefined };
};

export const hasOwnershipMarker = (displayName: string | undefined) =>
  Object.keys(parseDisplayName(displayName).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

export const ownedByAlchemy = (id: string, displayName: string | undefined) =>
  Effect.gen(function* () {
    const { labels } = parseDisplayName(displayName);
    return yield* hasAlchemyLabels(id, labels);
  });

export const ownershipLabels = (id: string) => createInternalLabels(id);

export const toDisplayName = (
  id: string,
  explicit: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined && explicit.length > 0) return explicit;
    if (existing !== undefined && existing.length > 0) return existing;
    return yield* createPhysicalName({
      id,
      maxLength: 40,
      lowercase: true,
    });
  });

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const replaceOnIdentity = (
  previous: string | undefined,
  next: string | undefined,
) =>
  previous !== undefined && next !== undefined && previous !== next
    ? ({ action: "replace" as const, deleteFirst: true } as const)
    : undefined;

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

export const getGroup = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : firebaseappdistribution
        .getProjectsGroups({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const listGroups = (parent: string) =>
  parent.length === 0
    ? Effect.succeed(
        [] as firebaseappdistribution.GoogleFirebaseAppdistroV1Group[],
      )
    : firebaseappdistribution.listProjectsGroups
        .pages({
          parent,
          pageSize: 100,
        })
        .pipe(
          Stream.take(10),
          Stream.flatMap((page) => Stream.fromIterable(page.groups ?? [])),
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
          Effect.catchTag(["NotFound", "Forbidden"], () =>
            Effect.succeed(
              [] as firebaseappdistribution.GoogleFirebaseAppdistroV1Group[],
            ),
          ),
        );

export const findOwnedGroup = (
  parent: string,
  id: string,
  name?: string,
  groupId?: string,
) =>
  Effect.gen(function* () {
    if (name && name.length > 0) {
      const match = yield* getGroup(name);
      if (match) return match;
    }
    const groups = yield* listGroups(parent);
    if (groupId) {
      const byId = groups.find(
        (group) => lastSegment(group.name ?? "") === groupId,
      );
      if (byId) return byId;
    }
    for (const group of groups) {
      if (yield* ownedByAlchemy(id, group.displayName)) return group;
    }
    return undefined;
  });
