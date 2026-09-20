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

/** The declared area tags, in rubric order (src/tasks/Tags.ts) —
 *  the board's filter pills; tags found in data extend the list. */
export const KNOWN_TAGS: ReadonlyArray<string> = [
  "cloudflare",
  "fly",
  "aws",
  "distilled",
  "forge",
  "org",
];

/** Each tag's chip classes — the issue StateBadge pattern (tinted bg
 *  + tinted text, a darker text step in light mode), one distinct hue
 *  per tag. NEVER moss/primary — that green is the agents' color —
 *  and never honey/amber, which melts into the tan accent. */
const TAG_COLORS: Record<string, string> = {
  cloudflare: "bg-orange-500/15 text-orange-700 dark:text-orange-400",
  fly: "bg-violet-500/15 text-violet-700 dark:text-violet-400",
  aws: "bg-blue-500/15 text-blue-700 dark:text-blue-400",
  distilled: "bg-cyan-500/15 text-cyan-700 dark:text-cyan-400",
  forge: "bg-rose-500/15 text-rose-700 dark:text-rose-400",
  org: "bg-slate-500/15 text-slate-600 dark:text-slate-400",
};

/** A tag's chip classes — unknown (data-seen) tags fall back to the
 *  neutral chip. */
export const tagColor = (tag: string): string =>
  TAG_COLORS[tag] ?? "bg-muted text-muted-foreground";

export interface TaskRow {
  readonly id: string;
  readonly queue: string;
  readonly title: string;
  readonly body: string;
  readonly state: TaskState;
  /** The task's area tags — tags[0] is the router's pick. */
  readonly tags: ReadonlyArray<string>;
  /** The member slug working/last working it (`engineer`). */
  readonly desk?: string;
  /** The task's thread root in the `tasks:<queue>` channel. */
  readonly rootPost?: string;
  /** `github:org/alchemy#1521` | `post:p-…` | `human`. */
  readonly origin?: string;
  readonly priority: number;
  readonly parkedReason?: string;
  /** Every desk that ever worked it — the affinity memory. */
  readonly workedBy?: ReadonlyArray<string>;
  /** The human's drag key among READY siblings (null = undragged). */
  readonly hint?: number;
  /** The scheduler's materialized rank (1 = claim next). */
  readonly rank?: number;
  /** One line of why — `judge:`-prefixed when the judged rank went
   *  against the human's dragged order. */
  readonly rankWhy?: string;
  /** The desk whose NEXT pick this ready row is — the board's
   *  `NEXT · <agent>` chip. */
  readonly nextFor?: string;
  readonly at: number;
  readonly updated: number;
}

/** One recorded step of a scheduler pick walk (src/judge/Walk.ts). */
export interface WalkStep {
  readonly question: string;
  readonly answer: string;
  readonly conviction: number;
  /** Task ids this step drilled into (bodies, threads). */
  readonly expanded: ReadonlyArray<string>;
  readonly elapsedMs: number;
}

/** The latest rank round's walk traces, per ready task. */
export interface WalkRound {
  readonly round: number;
  readonly at: number;
  readonly walks: ReadonlyArray<{
    readonly task: string;
    readonly trace: ReadonlyArray<WalkStep>;
  }>;
}

export const fetchWalks = (queue: string): Promise<WalkRound> =>
  fetch(`/api/tasks/${encodeURIComponent(queue)}/walks`).then(
    (response) => response.json() as Promise<WalkRound>,
  );

/** The hint axis's null band (mirrors src/tasks/TasksDO.ts): an
 *  undragged card's key is its age pushed past any explicit hint. */
export const HINT_NULL_OFFSET = 1_000_000_000_000_000;

/** Ready-column order: judged rank first, then the human's drag
 *  axis (nulls last by age) — the server's READY_ORDER, client-side. */
export const readyOrder = (a: TaskRow, b: TaskRow): number =>
  (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER) ||
  (a.hint ?? a.at + HINT_NULL_OFFSET) - (b.hint ?? b.at + HINT_NULL_OFFSET) ||
  a.at - b.at;

export interface TaskEventRow {
  readonly id: number;
  readonly task: string;
  /** routed|assigned|started|posted|parked|review_requested|
   *  changes_requested|approved|done|dropped|filed|tagged */
  readonly kind: string;
  readonly actor: string;
  /** JSON payload (post id, desk, reason…) — or a plain note. */
  readonly data?: string;
  readonly at: number;
}

/** One working round of a desk: the task and the session it runs in. */
export interface DeskWorking {
  readonly id: string;
  /** The round's session key — the trunk desk key, or a clone
   *  (`<deskKey>#<n>`) when the desk's width forked one. */
  readonly session: string;
}

export interface DeskSummary {
  /** The agent's TERM (`Engineer`) — the session id's first half. */
  readonly term: string;
  /** The member slug (`engineer`) — the desk's name on the board. */
  readonly slug: string;
  /** The desk's FULL session key (`root::tasks::<queue>::<agent>`). */
  readonly deskKey: string;
  /** How many tasks the desk may work at once (1..4) — 1 is the
   *  linear default; >1 forks clone sessions from the trunk. */
  readonly width: number;
  /** The tasks the desk is working right now, oldest claim first. */
  readonly working: ReadonlyArray<DeskWorking>;
  /** Recent tasks the desk touched (title + tags) — the affinity
   *  signal. */
  readonly recent: ReadonlyArray<{
    readonly title: string;
    readonly tags: ReadonlyArray<string>;
  }>;
}

export interface QueueSummary {
  readonly name: string;
  readonly slug: string;
  readonly prose: string;
  readonly desks: ReadonlyArray<DeskSummary>;
}

/** A desk's SESSION id (`Engineer:root::tasks::engineering::engineer`)
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

/** The human's DRAG among ready siblings — a soft hint the staged
 *  scheduler weighs (it may deviate; the card's why line says so). */
export const reorderTask = (
  queue: string,
  id: string,
  anchor: { readonly before?: string; readonly after?: string },
): Promise<Response> =>
  fetch(
    `/api/tasks/${encodeURIComponent(queue)}/${encodeURIComponent(id)}/reorder`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(anchor),
    },
  );

/** Replace the task's tags — a `tagged` timeline event on the server. */
export const retagTask = (
  queue: string,
  id: string,
  tags: ReadonlyArray<string>,
): Promise<Response> =>
  fetch(
    `/api/tasks/${encodeURIComponent(queue)}/${encodeURIComponent(id)}/retag`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tags }),
    },
  );

/** Dial the desk's width — the parallelism control (clamped 1..4 by
 *  the board). */
export const setDeskWidth = (
  queue: string,
  desk: string,
  width: number,
): Promise<Response> =>
  fetch(
    `/api/tasks/${encodeURIComponent(queue)}/desks/${encodeURIComponent(desk)}/width`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ width }),
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
