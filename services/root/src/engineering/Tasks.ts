import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/**
 * The TASK LEDGER — what the EngineeringManager maintains out of the
 * triage stream, on ITS thread (the recursion: Manager : its thread ::
 * Head : Root).
 *
 * A TASK holds 1..* ITEMS because the real world is chaotic: a PR
 * lands with no issue; an issue is filed and abandoned; an issue gets
 * a surprise PR a day after work started. Items JOIN and LEAVE; the
 * task persists — it is the unit of work, assignment, and status. The
 * statuses are the classic four the manager moves work through:
 * todo → working → review → done.
 */

export type TaskStatus = "todo" | "working" | "review" | "done";

export interface TaskItem {
  /** `owner/repo#N` for GitHub entities; a short label for ad-hoc
   *  direct requests. */
  readonly ref: string;
  readonly kind: "issue" | "pull" | "request";
}

export interface Task {
  readonly id: string;
  readonly title: string;
  readonly items: ReadonlyArray<TaskItem>;
  readonly status: TaskStatus;
  /** The engineer working it — a lineage name (`e-4f2a`). */
  readonly assignee?: string;
  /** The workspace the work lives in — a workspace name (`pr-1521`). */
  readonly workspace?: string;
  readonly notes: ReadonlyArray<string>;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export class Tasks extends Context.Service<
  Tasks,
  {
    readonly upsert: (input: {
      readonly id?: string;
      readonly title?: string;
      readonly status?: TaskStatus;
      readonly assignee?: string | null;
      readonly workspace?: string | null;
      readonly addItems?: ReadonlyArray<TaskItem>;
      readonly removeItems?: ReadonlyArray<string>;
      readonly note?: string;
    }) => Effect.Effect<Task>;
    readonly read: (id: string) => Effect.Effect<Task | undefined>;
    readonly list: (status?: TaskStatus) => Effect.Effect<ReadonlyArray<Task>>;
    /** The task (if any) that already covers a ref — how a late PR
     *  joins the issue's task instead of forking a duplicate. */
    readonly covering: (ref: string) => Effect.Effect<Task | undefined>;
  }
>()("Tasks") {}
