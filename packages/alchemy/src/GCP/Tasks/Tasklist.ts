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
  encodeOwnershipLine,
  findOwnedTasklist,
  getTasklist,
  hasOwnershipMarker,
  ignoreMissing,
  isDefaultTasklist,
  listOwnedTasklists,
  MAX_TITLE_LENGTH,
  ownedByAlchemy,
  ownershipLabels,
  parseOwnership,
  sameText,
  toGeneratedName,
} from "./internal.ts";

export type TasklistProps = {
  /**
   * Task list id. Server-assigned on create. Use `"@default"` for the
   * authenticated user's default list. Immutable — changing it
   * replaces the list.
   */
  tasklistId?: string;
  /**
   * Title of the task list (max 1024 characters including Alchemy's
   * ownership marker). Task lists have no labels field, so ownership
   * is stored in a `[alchemy …]` prefix and stripped from attributes.
   */
  title?: string;
};

export type Tasklist = Resource<
  "GCP.Tasks.Tasklist",
  TasklistProps,
  {
    /** Task list id. */
    tasklistId: string;
    /** Project id used when the list was reconciled. */
    project: string;
    /** User-facing title with the Alchemy ownership prefix stripped. */
    title: string | undefined;
    /** API self link. */
    selfLink: string | undefined;
    /** RFC3339 last-modification timestamp. */
    updated: string | undefined;
    /** ETag. */
    etag: string | undefined;
    /** Resource kind (`tasks#taskList`). */
    kind: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Google Tasks task list.
 *
 * Task lists have no labels field, so Alchemy stamps ownership into
 * `title` for `list` / nuke. The list id is identity — changing it
 * replaces the list. Title updates in place. The authenticated user's
 * default list (`@default`) cannot be deleted. Creating lists as a
 * service account is not recommended; use a user OAuth token or
 * domain-wide delegation.
 *
 * ### Creating a Task List
 * **Example:** Generated title
 * ```typescript
 * const list = yield* GCP.Tasks.Tasklist("Inbox", {});
 * ```
 *
 * **Example:** Named list
 * ```typescript
 * const list = yield* GCP.Tasks.Tasklist("Inbox", {
 *   title: "Engineering",
 * });
 * ```
 *
 * ### Updating a Task List
 * **Example:** Rename
 * ```typescript
 * const list = yield* GCP.Tasks.Tasklist("Inbox", {
 *   tasklistId: existing.tasklistId,
 *   title: "Platform",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Tasks
 */
export const Tasklist = Resource<Tasklist>("GCP.Tasks.Tasklist");

export class TasklistNotResolved extends Data.TaggedError(
  "GCP.Tasks.TasklistNotResolved",
)<{
  tasklistId: string;
}> {}

const toAttrs = (item: tasks.TaskList, project: string) => ({
  tasklistId: item.id ?? "",
  project,
  title: parseOwnership(item.title).text,
  selfLink: item.selfLink,
  updated: item.updated,
  etag: item.etag,
  kind: item.kind,
});

export const TasklistProvider = () =>
  Provider.succeed(Tasklist, {
    stables: ["tasklistId", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.tasklistId ?? output?.tasklistId;
      if (
        previousId !== undefined &&
        news.tasklistId !== undefined &&
        news.tasklistId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const tasklistId = olds?.tasklistId ?? output?.tasklistId ?? "";
      let existing = yield* getTasklist(tasklistId);
      if (existing === undefined) {
        existing = yield* findOwnedTasklist(id);
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, existing.title))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listOwnedTasklists();
        return items
          .filter((item) => hasOwnershipMarker(item.title))
          .map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const labels = yield* ownershipLabels(id);
      const displayTitle = yield* toGeneratedName(
        id,
        news.title,
        output?.title,
      );
      const title = encodeOwnershipLine(labels, displayTitle, MAX_TITLE_LENGTH);
      const desired: tasks.TaskList = {
        title,
      };

      let current = yield* getTasklist(
        news.tasklistId ?? output?.tasklistId ?? "",
      );
      if (current === undefined) {
        current = yield* findOwnedTasklist(id);
      }

      if (current === undefined) {
        const created = yield* tasks
          .insertTasklists({ body: desired })
          .pipe(Effect.catchTag("Conflict", () => findOwnedTasklist(id)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new TasklistNotResolved({
          tasklistId: news.tasklistId ?? output?.tasklistId ?? title,
        });
      }

      const tasklistId =
        current.id ?? news.tasklistId ?? output?.tasklistId ?? "";
      if (!sameText(current.title, title)) {
        current = yield* tasks.patchTasklists({
          tasklist: tasklistId,
          body: desired,
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (isDefaultTasklist(output.tasklistId)) return;
      yield* ignoreMissing(
        tasks.deleteTasklists({
          tasklist: output.tasklistId,
        }),
      );
    }),
  });
