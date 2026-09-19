import * as tasks from "@distilled.cloud/gcp/tasks_v1";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";

export const DEFAULT_TASKLIST = "@default";
export const MAX_TITLE_LENGTH = 1024;
export const MAX_NOTES_LENGTH = 8192;

const markerOf = (
  _labels: Record<string, string>,
  stack: string,
  stage: string,
  id: string,
) =>
  `[alchemy ${alchemyLabelKeys.stack}=${stack} ${alchemyLabelKeys.stage}=${stage} ${alchemyLabelKeys.id}=${id}]`;

const fitMarker = (labels: Record<string, string>, maxLength: number) => {
  let stack = labels[alchemyLabelKeys.stack] ?? "x";
  let stage = labels[alchemyLabelKeys.stage] ?? "x";
  let id = labels[alchemyLabelKeys.id] ?? "x";
  let marker = markerOf(labels, stack, stage, id);
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
    marker = markerOf(labels, stack, stage, id);
  }
  return marker.slice(0, maxLength);
};

export const encodeOwnership = (
  labels: Record<string, string>,
  text: string | undefined,
  maxLength = MAX_NOTES_LENGTH,
): string => {
  const marker = fitMarker(labels, Math.min(8000, maxLength));
  const trimmed = text?.trim();
  const combined =
    trimmed && trimmed.length > 0 ? `${marker}\n${trimmed}` : marker;
  return combined.slice(0, maxLength);
};

export const encodeOwnershipLine = (
  labels: Record<string, string>,
  text: string | undefined,
  maxLength = MAX_TITLE_LENGTH,
): string => {
  const trimmed = text?.replace(/[\r\n]+/g, " ").trim();
  if (!trimmed) return fitMarker(labels, maxLength);
  const minMarker = 24;
  const reserved = Math.min(
    trimmed.length + 1,
    Math.max(0, maxLength - minMarker),
  );
  const marker = fitMarker(labels, maxLength - reserved);
  return `${marker} ${trimmed}`.slice(0, maxLength);
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
  const rest = text.slice(end + 1).replace(/^[\s\n]+/, "");
  return { labels, text: rest.length > 0 ? rest : undefined };
};

export const hasOwnershipMarker = (text: string | undefined) => {
  if (
    Object.keys(parseOwnership(text).labels).some((key) =>
      key.startsWith("alchemy-"),
    )
  ) {
    return true;
  }
  return (text ?? "").toLowerCase().includes("alchemy-");
};

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

export const ownershipLabels = (id: string) => createInternalLabels(id);

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const jsonEqual = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

export const isDefaultTasklist = (tasklistId: string) =>
  tasklistId === DEFAULT_TASKLIST || tasklistId.length === 0;

export const toGeneratedName = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
  maxLength = 40,
) =>
  Effect.gen(function* () {
    if (requested !== undefined && requested.length > 0) {
      return requested;
    }
    if (existing !== undefined && existing.length > 0) {
      return existing;
    }
    const generated = yield* createPhysicalName({
      id,
      maxLength,
      lowercase: true,
    });
    const next = /^[a-z]/.test(generated)
      ? generated
      : `t${generated}`.slice(0, maxLength);
    return next.length >= 4 ? next : `${next}xxxx`.slice(0, maxLength);
  });

const emptyList = <A>() => Effect.succeed([] as A[]);

export const catchMissing = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.catchIf(
      (error): error is E & { readonly _tag: "NotFound" | "Forbidden" } =>
        error._tag === "NotFound" || error._tag === "Forbidden",
      () => Effect.succeed(undefined),
    ),
  );

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

export const getTasklist = (tasklistId: string) =>
  tasklistId.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(tasks.getTasklists({ tasklist: tasklistId }));

export const listTasklists = () =>
  tasks.listTasklists
    .pages({
      maxResults: 100,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.items ?? [])),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => emptyList<tasks.TaskList>()),
      Effect.catchTag("Forbidden", () => emptyList<tasks.TaskList>()),
    );

export const listOwnedTasklists = () =>
  listTasklists().pipe(
    Effect.map((items) =>
      items.filter((item) => hasOwnershipMarker(item.title)),
    ),
  );

export const findOwnedTasklist = (id: string) =>
  Effect.gen(function* () {
    const items = yield* listOwnedTasklists();
    for (const item of items) {
      if (yield* ownedByAlchemy(id, item.title)) {
        return item;
      }
    }
    return undefined;
  });

export const getTask = (tasklistId: string, taskId: string) =>
  tasklistId.length === 0 || taskId.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(
        tasks.getTasks({
          tasklist: tasklistId,
          task: taskId,
        }),
      );

export const listTasks = (tasklistId: string) =>
  tasklistId.length === 0
    ? emptyList<tasks.Task>()
    : tasks.listTasks
        .pages({
          tasklist: tasklistId,
          maxResults: 100,
          showCompleted: true,
          showHidden: true,
          showDeleted: false,
        })
        .pipe(
          Stream.flatMap((page) => Stream.fromIterable(page.items ?? [])),
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
          Effect.catchTag("NotFound", () => emptyList<tasks.Task>()),
          Effect.catchTag("Forbidden", () => emptyList<tasks.Task>()),
        );

export type TaskWithList = tasks.Task & { tasklistId: string };

export const taskOwnershipText = (task: tasks.Task) =>
  hasOwnershipMarker(task.notes) ? task.notes : task.title;

export const hasAlchemyTaskMarker = (task: tasks.Task) =>
  hasOwnershipMarker(task.notes) || hasOwnershipMarker(task.title);

export const listOwnedTasksOnList = (tasklistId: string) =>
  listTasks(tasklistId).pipe(
    Effect.map((items) =>
      items.filter(hasAlchemyTaskMarker).map((task): TaskWithList => ({
        ...task,
        tasklistId,
      })),
    ),
  );

export const listOwnedTasks = () =>
  Effect.gen(function* () {
    const lists = yield* listTasklists();
    const pages = yield* Effect.forEach(
      lists.filter((item) => (item.id ?? "").length > 0),
      (item) => listOwnedTasksOnList(item.id ?? ""),
      { concurrency: 4 },
    );
    return pages.flat();
  });

export const findOwnedTask = (id: string, tasklistId: string) =>
  Effect.gen(function* () {
    const items =
      tasklistId.length > 0
        ? yield* listOwnedTasksOnList(tasklistId)
        : yield* listOwnedTasks();
    for (const item of items) {
      if (yield* ownedByAlchemy(id, taskOwnershipText(item))) {
        return item;
      }
    }
    return undefined;
  });
