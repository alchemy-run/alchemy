import * as tasks from "@distilled.cloud/gcp/tasks_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  encodeOwnership,
  findOwnedTask,
  getTask,
  hasAlchemyTaskMarker,
  ignoreMissing,
  listOwnedTasks,
  MAX_NOTES_LENGTH,
  ownedByAlchemy,
  ownershipLabels,
  parseOwnership,
  sameText,
  taskOwnershipText,
  toGeneratedName,
} from "./internal.ts";

export type TaskLinksItem = {
  /** Link type, for example `"email"` or `"generic"`. */
  type?: string;
  /** The URL. */
  link?: string;
  /** Description of the link. */
  description?: string;
};

export type TaskAssignmentInfo = {
  /** Surface this assigned task originates from. */
  surfaceType?: string;
  /** Absolute link to the original task on the assignment surface. */
  linkToTask?: string;
  /** Drive file that originated this assignment. */
  driveResourceInfo?: {
    driveFileId?: string;
    resourceKey?: string;
  };
  /** Chat space that originated this assignment. */
  spaceInfo?: {
    space?: string;
  };
};

export type TaskProps = {
  /**
   * Parent task list id. Immutable — changing it replaces the task.
   */
  tasklistId: string;
  /**
   * Task id. Server-assigned on create. Immutable — changing it
   * replaces the task.
   */
  taskId?: string;
  /**
   * Title of the task (max 1024 characters). If omitted, a unique
   * name is generated from the stack, stage, and logical id.
   */
  title?: string;
  /**
   * Notes describing the task (max 8192 characters). Tasks have no
   * labels field, so Alchemy ownership is stored in a `[alchemy …]`
   * prefix and stripped from attributes.
   */
  notes?: string;
  /**
   * Scheduled date as an RFC 3339 timestamp. Only the date portion is
   * stored; the time is discarded.
   */
  due?: string;
  /**
   * Status of the task: `needsAction` or `completed`.
   */
  status?: string;
  /**
   * Completion timestamp as RFC 3339. Omitted when the task is not
   * completed.
   */
  completed?: string;
  /**
   * Parent task id. Set on create and via `tasks.move` on update.
   * Assigned tasks cannot be parents or children.
   */
  parent?: string;
  /**
   * Previous sibling task id. Set on create and via `tasks.move` on
   * update. Omit to place the task first among its siblings.
   */
  previous?: string;
};

export type Task = Resource<
  "GCP.Tasks.Task",
  TaskProps,
  {
    /** Task id. */
    taskId: string;
    /** Parent task list id. */
    tasklistId: string;
    /** Project id used when the task was reconciled. */
    project: string;
    /** Title. */
    title: string | undefined;
    /** User notes with the Alchemy ownership prefix stripped. */
    notes: string | undefined;
    /** Scheduled date. */
    due: string | undefined;
    /** Status (`needsAction` or `completed`). */
    status: string | undefined;
    /** Completion timestamp. */
    completed: string | undefined;
    /** Parent task id, when nested. */
    parent: string | undefined;
    /** Lexicographic sibling position. */
    position: string | undefined;
    /** Whether the task is hidden after a list clear. */
    hidden: boolean | undefined;
    /** Whether the task has been deleted. */
    deleted: boolean | undefined;
    /** Web UI link. */
    webViewLink: string | undefined;
    /** API self link. */
    selfLink: string | undefined;
    /** Attached links. */
    links: TaskLinksItem[] | undefined;
    /** Assignment context for tasks assigned from Docs or Chat. */
    assignmentInfo: TaskAssignmentInfo | undefined;
    /** RFC3339 last-modification timestamp. */
    updated: string | undefined;
    /** ETag. */
    etag: string | undefined;
    /** Resource kind (`tasks#task`). */
    kind: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Google Tasks task on a task list.
 *
 * Tasks have no labels field, so Alchemy stamps ownership into
 * `notes` for `list` / nuke. Parent list and task id are identity —
 * changing either replaces the task. Title, notes, due date, and
 * status update in place. Parent and previous sibling are applied
 * with `tasks.move`. Creating tasks as a service account is not
 * recommended; use a user OAuth token or domain-wide delegation.
 *
 * ### Creating a Task
 * **Example:** Task on a list
 * ```typescript
 * const item = yield* GCP.Tasks.Task("Ship", {
 *   tasklistId: list.tasklistId,
 *   title: "Ship the release",
 *   notes: "Cut 2.0",
 * });
 * ```
 *
 * **Example:** Task with a due date
 * ```typescript
 * const item = yield* GCP.Tasks.Task("Review", {
 *   tasklistId: list.tasklistId,
 *   title: "Review PRs",
 *   due: "2030-01-15T00:00:00.000Z",
 *   status: "needsAction",
 * });
 * ```
 *
 * ### Updating a Task
 * **Example:** Complete the task
 * ```typescript
 * const item = yield* GCP.Tasks.Task("Ship", {
 *   tasklistId: existing.tasklistId,
 *   taskId: existing.taskId,
 *   title: "Ship the release",
 *   status: "completed",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Tasks
 */
export const Task = Resource<Task>("GCP.Tasks.Task");

export class TaskNotResolved extends Data.TaggedError(
  "GCP.Tasks.TaskNotResolved",
)<{
  tasklistId: string;
  taskId: string;
}> {}

const linksOf = (
  links: tasks.TaskLinksItemList | undefined,
): TaskLinksItem[] | undefined => {
  if (links === undefined) return undefined;
  return links.map((item) => ({
    type: item.type,
    link: item.link,
    description: item.description,
  }));
};

const assignmentOf = (
  info: tasks.AssignmentInfo | undefined,
): TaskAssignmentInfo | undefined => {
  if (info === undefined) return undefined;
  return {
    surfaceType: info.surfaceType,
    linkToTask: info.linkToTask,
    driveResourceInfo:
      info.driveResourceInfo === undefined
        ? undefined
        : {
            driveFileId: info.driveResourceInfo.driveFileId,
            resourceKey: info.driveResourceInfo.resourceKey,
          },
    spaceInfo:
      info.spaceInfo === undefined
        ? undefined
        : { space: info.spaceInfo.space },
  };
};

const toAttrs = (item: tasks.Task, tasklistId: string, project: string) => ({
  taskId: item.id ?? "",
  tasklistId,
  project,
  title: item.title,
  notes: parseOwnership(item.notes).text,
  due: item.due,
  status: item.status,
  completed: item.completed,
  parent: item.parent,
  position: item.position,
  hidden: item.hidden,
  deleted: item.deleted,
  webViewLink: item.webViewLink,
  selfLink: item.selfLink,
  links: linksOf(item.links),
  assignmentInfo: assignmentOf(item.assignmentInfo),
  updated: item.updated,
  etag: item.etag,
  kind: item.kind,
});

export const TaskProvider = () =>
  Provider.succeed(Task, {
    stables: ["taskId", "tasklistId", "project", "webViewLink", "selfLink"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousList = olds?.tasklistId ?? output?.tasklistId;
      if (previousList !== undefined && news.tasklistId !== previousList) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.taskId ?? output?.taskId;
      if (
        previousId !== undefined &&
        news.taskId !== undefined &&
        news.taskId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const tasklistId = olds?.tasklistId ?? output?.tasklistId ?? "";
      const taskId = olds?.taskId ?? output?.taskId ?? "";
      let existing = yield* getTask(tasklistId, taskId);
      let listId = tasklistId;
      if (existing === undefined) {
        const owned = yield* findOwnedTask(id, tasklistId);
        existing = owned;
        if (owned !== undefined) {
          listId = owned.tasklistId;
        }
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, listId, env.project);
      return (yield* ownedByAlchemy(id, taskOwnershipText(existing)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listOwnedTasks();
        return items
          .filter(hasAlchemyTaskMarker)
          .map((item) => toAttrs(item, item.tasklistId, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const tasklistId = news.tasklistId;
      const labels = yield* ownershipLabels(id);
      const title = yield* toGeneratedName(id, news.title, output?.title);
      const notes = encodeOwnership(labels, news.notes, MAX_NOTES_LENGTH);
      const desired: tasks.Task = {
        title,
        notes,
        due: news.due,
        status: news.status,
        completed: news.completed,
      };

      let current = yield* getTask(
        tasklistId,
        news.taskId ?? output?.taskId ?? "",
      );
      if (current === undefined) {
        current = yield* findOwnedTask(id, tasklistId);
      }

      if (current === undefined) {
        const created = yield* tasks
          .insertTasks({
            tasklist: tasklistId,
            parent: news.parent,
            previous: news.previous,
            body: desired,
          })
          .pipe(
            Effect.catchTag("Conflict", () => findOwnedTask(id, tasklistId)),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new TaskNotResolved({
          tasklistId,
          taskId: news.taskId ?? output?.taskId ?? title,
        });
      }

      const taskId = current.id ?? news.taskId ?? output?.taskId ?? "";
      const titleChanged = !sameText(current.title, title);
      const notesChanged = !sameText(current.notes, notes);
      const dueChanged =
        news.due !== undefined && !sameText(current.due, news.due);
      const statusChanged =
        news.status !== undefined && !sameText(current.status, news.status);
      const completedChanged =
        news.completed !== undefined &&
        !sameText(current.completed, news.completed);

      if (
        titleChanged ||
        notesChanged ||
        dueChanged ||
        statusChanged ||
        completedChanged
      ) {
        current = yield* tasks.patchTasks({
          tasklist: tasklistId,
          task: taskId,
          body: desired,
        });
      }

      const parentChanged =
        news.parent !== undefined && !sameText(current.parent, news.parent);
      const previousSet = news.previous !== undefined;
      if (parentChanged || previousSet) {
        current = yield* tasks.moveTasks({
          tasklist: tasklistId,
          task: taskId,
          parent: news.parent,
          previous: news.previous,
        });
      }

      return toAttrs(current, tasklistId, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.taskId.length === 0 || output.tasklistId.length === 0) {
        return;
      }
      yield* ignoreMissing(
        tasks.deleteTasks({
          tasklist: output.tasklistId,
          task: output.taskId,
        }),
      );
    }),
  });
