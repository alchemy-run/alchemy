/**
 * The TASKS surface's client — `/api/tasks/*` (TasksApi.ts), plain
 * fetch like lib/forge.ts. The shapes mirror src/tasks/TasksDO.ts.
 */

export type TaskState =
  | "inbox"
  | "ready"
  | "working"
  | "review"
  | "parked"
  | "done"
  | "dropped";

/** The board's columns, in order (`dropped` folds into done's tail). */
export const BOARD_STATES: ReadonlyArray<TaskState> = [
  "inbox",
  "ready",
  "working",
  "review",
  "parked",
  "done",
];

/** The legal state machine — mirrors TasksDO's TRANSITIONS so the
 *  Move to… menu only offers hops the board will accept. */
export const TRANSITIONS: Record<TaskState, ReadonlyArray<TaskState>> = {
  inbox: ["ready", "dropped"],
  ready: ["working", "inbox", "parked", "dropped"],
  working: ["review", "ready", "parked", "done", "inbox", "dropped"],
  review: ["working", "ready", "done", "parked", "dropped"],
  parked: ["ready", "inbox", "dropped"],
  done: [],
  dropped: [],
};

export interface TaskRow {
  readonly id: string;
  readonly queue: string;
  readonly title: string;
  readonly body: string;
  readonly state: TaskState;
  /** The member slug working/last working it (`engineer`). */
  readonly desk?: string;
  /** The task's thread root in the `tasks:<queue>` channel. */
  readonly rootPost?: string;
  /** `github:org/alchemy#1521` | `post:p-…` | `human`. */
  readonly origin?: string;
  readonly priority: number;
  readonly parkedReason?: string;
  readonly at: number;
  readonly updated: number;
}

export interface TaskEventRow {
  readonly id: number;
  readonly task: string;
  /** routed|assigned|started|posted|parked|review_requested|
   *  changes_requested|approved|done|dropped|filed */
  readonly kind: string;
  readonly actor: string;
  /** JSON payload (post id, desk, reason…) — or a plain note. */
  readonly data?: string;
  readonly at: number;
}

export interface DeskSummary {
  /** The agent's TERM (`Engineer`) — the session id's first half. */
  readonly term: string;
  /** The member slug (`engineer`) — the desk's name on the board. */
  readonly slug: string;
  /** The desk's FULL session key (`root::tasks::<queue>::<agent>`). */
  readonly deskKey: string;
  /** The id of the task the desk is working, if any. */
  readonly working?: string;
  /** Recent titles the desk touched — the affinity signal. */
  readonly recent: ReadonlyArray<string>;
}

export interface QueueSummary {
  readonly name: string;
  readonly slug: string;
  readonly prose: string;
  readonly desks: ReadonlyArray<DeskSummary>;
}

/** A desk's SESSION id (`Engineer:root::tasks::cloudflare::engineer`)
 *  — what `?panes=a:<id>`, `/api/chats/:id/*` address. */
export const deskSessionId = (desk: DeskSummary): string =>
  `${desk.term}:${desk.deskKey}`;

export const fetchQueues = (): Promise<ReadonlyArray<QueueSummary>> =>
  fetch("/api/tasks/queues")
    .then((response) => response.json() as Promise<{ queues: QueueSummary[] }>)
    .then((body) => body.queues);

export const fetchBoard = (
  queue: string,
): Promise<Record<TaskState, ReadonlyArray<TaskRow>>> =>
  fetch(`/api/tasks/${encodeURIComponent(queue)}`)
    .then(
      (response) =>
        response.json() as Promise<{
          tasks: Record<TaskState, ReadonlyArray<TaskRow>>;
        }>,
    )
    .then((body) => body.tasks);

export const fetchTask = (
  queue: string,
  id: string,
): Promise<{ task: TaskRow; events: ReadonlyArray<TaskEventRow> }> =>
  fetch(
    `/api/tasks/${encodeURIComponent(queue)}/${encodeURIComponent(id)}`,
  ).then(
    (response) =>
      response.json() as Promise<{
        task: TaskRow;
        events: ReadonlyArray<TaskEventRow>;
      }>,
  );

/** Human override — a `routed` hop with actor `sam` on the server. */
export const routeTask = (
  queue: string,
  id: string,
  state: TaskState,
  options?: { readonly desk?: string; readonly data?: string },
): Promise<Response> =>
  fetch(
    `/api/tasks/${encodeURIComponent(queue)}/${encodeURIComponent(id)}/route`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state, ...options }),
    },
  );

export const commentTask = (
  queue: string,
  id: string,
  text: string,
): Promise<Response> =>
  fetch(
    `/api/tasks/${encodeURIComponent(queue)}/${encodeURIComponent(id)}/comment`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    },
  );

/** A task's ORIGIN, parsed for the chip: a github issue/pull ref, a
 *  post reference, or plain prose (`human`). */
export type TaskOrigin =
  | { readonly kind: "github"; readonly repo: string; readonly number: number }
  | { readonly kind: "post"; readonly id: string }
  | { readonly kind: "plain"; readonly text: string };

export const parseOrigin = (origin: string): TaskOrigin => {
  const github = /^github:(?:[^/#]+\/)?([^#]+)#(\d+)$/.exec(origin);
  if (github !== null) {
    return { kind: "github", repo: github[1]!, number: Number(github[2]) };
  }
  if (origin.startsWith("post:")) {
    return { kind: "post", id: origin.slice(5) };
  }
  return { kind: "plain", text: origin };
};
