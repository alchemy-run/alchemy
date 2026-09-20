/**
 * THE DESK WORLD — the scripted fixture behind both the desk-loop
 * test suite (test/tasks/desk-loop.test.ts) and the eval harness
 * (eval/run.ts): an in-memory board mirroring TasksDO's semantics, a
 * scripted desk per member, and a System One that answers from code
 * unless a REAL one is injected (`options.query`) — which is how the
 * evals judge the control plane (scheduler picks, forgotten-line
 * dispositions, review verdicts) against the live TypeSafe API while
 * the desks themselves stay scripted.
 */
import type * as AI from "alchemy/AI";
import type * as TypeSafe from "alchemy/TypeSafe";
import * as Effect from "effect/Effect";
import type {
  DeskBoard,
  DeskDeps,
  DeskMember,
  QueueSpec,
} from "../src/tasks/Desks.ts";
import {
  transition,
  type RouteInput,
  type TaskEventRow,
  type TaskRow,
  type TaskState,
} from "../src/tasks/TasksDO.ts";

export const QUEUE: QueueSpec = {
  name: "Engineering",
  slug: "engineering",
  worker: { term: "Engineer", slug: "engineer" },
  reviewer: { term: "Reviewer", slug: "reviewer" },
};

export interface WorldPost {
  readonly id: string;
  readonly replyTo?: string;
  readonly author: string;
  readonly text: string;
}

export const TRUNK = "root::tasks::engineering::engineer";

/** The whole fixture, explicitly: rows, a clock counter, per-member
 *  answer scripts, and a System One that answers from code. */
export const deskWorld = (options?: {
  maxWorkingDesks?: number;
  /** A REAL System One — replaces the scripted one wholesale, so the
   *  scheduler's wide Choice, the forgotten-line disposition, and the
   *  review Noul are all judged live (the eval harness's seam). */
  query?: typeof TypeSafe.SystemOne.Service;
}) => {
  interface Row {
    id: string;
    queue: string;
    title: string;
    body: string;
    state: TaskState;
    tags: ReadonlyArray<string>;
    desk?: string;
    session?: string;
    rootPost?: string;
    origin?: string;
    priority: number;
    parkedReason?: string;
    at: number;
    updated: number;
  }
  const rows = new Map<string, Row>();
  const events: Array<Omit<TaskEventRow, "id"> & { id: number }> = [];
  const posts: WorldPost[] = [];
  const scripts: Record<string, string[]> = {};
  const taskScripts: Record<string, Record<string, string[]>> = {};
  const dispatches: Array<
    { member: string; task: string; key: string; ask: string }
  > = [];
  const digests: Array<{ term: string; key: string }> = [];
  const digestSends: Array<{ term: string; key: string }> = [];
  const widths: Record<string, number> = {};
  const branches: Array<{ ref: string; key: string }> = [];
  const merges: Array<{ term: string; key: string; text: string }> = [];
  const observed: string[] = [];
  let now = 0;
  let spent = 0;

  const tick = () => ++now;
  const toTask = (row: Row): TaskRow => ({ ...row });
  const event = (task: string, kind: string, actor: string, data?: string) => {
    events.push({
      id: events.length + 1,
      task,
      kind,
      actor,
      ...(data === undefined ? {} : { data }),
      at: tick(),
    });
  };
  const ordered = (state: TaskState) =>
    [...rows.values()]
      .filter((row) => row.state === state)
      .sort((a, b) => a.priority - b.priority || a.at - b.at);
  const move = (row: Row, input: RouteInput) => {
    row.state = input.state;
    row.desk =
      input.desk ?? (input.state === "inbox" ? undefined : row.desk);
    row.parkedReason =
      input.state === "parked" ? (input.data ?? undefined) : undefined;
    row.updated = tick();
    event(
      row.id,
      input.kind ??
        (
          {
            inbox: "routed",
            ready: "routed",
            working: "started",
            review: "review_requested",
            parked: "parked",
            done: "done",
            dropped: "dropped",
          } as Record<TaskState, string>
        )[input.state],
      input.actor,
      input.data,
    );
    return toTask(row);
  };

  // the board — TasksDO's semantics, in memory, same pure `transition`
  const board: DeskBoard = {
    list: (state) => Effect.sync(() => ordered(state).map(toTask)),
    claimNext: (desk, options) =>
      Effect.sync(() => {
        const from = options?.from ?? "ready";
        const working = [...rows.values()].filter(
          (row) => row.state === "working" && row.desk === desk,
        );
        if (working.length >= (widths[desk] ?? 1)) return undefined;
        // one round per session — the trunk-race refusal (TasksDO)
        if (
          options?.session !== undefined &&
          working.some((row) => row.session === options.session)
        ) {
          return undefined;
        }
        const preferred =
          options?.preferred === undefined
            ? undefined
            : rows.get(options.preferred);
        const chosen =
          preferred !== undefined && preferred.state === from
            ? preferred
            : ordered(from)[0];
        if (chosen === undefined) return undefined;
        chosen.session = options?.session;
        event(
          chosen.id,
          "assigned",
          "scheduler",
          JSON.stringify({
            desk,
            ...(options?.session === undefined
              ? {}
              : { session: options.session }),
          }),
        );
        return move(chosen, {
          state: "working",
          desk,
          actor: desk,
          kind: "started",
        });
      }),
    route: (id, input) =>
      Effect.sync(() => {
        const row = rows.get(id);
        if (row === undefined || !transition(row.state, input.state)) {
          return undefined;
        }
        return move(row, input);
      }),
    deskState: (desk) =>
      Effect.sync(() => ({
        working: [...rows.values()]
          .filter((row) => row.state === "working" && row.desk === desk)
          .sort((a, b) => a.updated - b.updated)
          .map(toTask),
        width: widths[desk] ?? 1,
        recent: [...rows.values()]
          .filter((row) => row.desk === desk && row.state !== "working")
          .sort((a, b) => b.updated - a.updated)
          .slice(0, 5)
          .map((row) => ({ title: row.title, tags: row.tags })),
      })),
    events: (id) =>
      Effect.sync(() => events.filter((row) => row.task === id)),
    comment: (id, actor, post) =>
      Effect.sync(() => {
        event(id, "posted", actor, JSON.stringify({ post }));
      }),
    spendDispatch: () =>
      Effect.sync(() => {
        if (spent >= 20) return false;
        spent += 1;
        return true;
      }),
  };

  // the scripted System One: review verdicts and forgotten-line
  // dispositions answer from code; everything else (the scheduler's
  // wide Choice) is unscripted — a defect tryQuery turns into the
  // FIFO fallback, which is exactly what a deterministic test wants
  const scriptedQuery = ((questions: Record<string, unknown>, opts: {
    state: Record<string, unknown>;
  }) =>
    Effect.sync(() => {
      if ("changes" in questions) {
        const review = String(opts.state.review ?? "");
        const noul = /changes needed|fix|defect|racy/i.test(review)
          ? 0.92
          : 0.06;
        return {
          value: { changes: noul >= 0.5 },
          answers: { changes: { noul } },
        };
      }
      if ("disposition" in questions) {
        return {
          value: { disposition: "complete" },
          answers: { disposition: { confidence: 0.9 } },
        };
      }
      throw new Error("unscripted question");
    })) as unknown as typeof TypeSafe.SystemOne.Service;

  const query = options?.query ?? scriptedQuery;

  // the desk sessions' durable logs BY KEY, as recovery reads them —
  // tests seed them to simulate rounds that finished with no waiter
  // alive; `sessionLog` stays the engineer TRUNK's log
  const sessionLogs = new Map<string, Array<AI.SessionObservation>>();
  const sessionLog: Array<AI.SessionObservation> = [];
  sessionLogs.set(TRUNK, sessionLog);

  const deps: DeskDeps = {
    query,
    board: () => board,
    history: (_member, key) =>
      Effect.sync(() => (sessionLogs.get(key) ?? []).slice()),
    post: (input) =>
      Effect.sync(() => {
        const id = `w-${posts.length + 1}`;
        posts.push({
          id,
          ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
          author: input.author,
          text: input.text,
        });
        return id;
      }),
    dispatch: (member: DeskMember, input) =>
      Effect.sync(() => {
        const task = /\[(?:task|review) (t-[\w-]+)/.exec(input.ask)?.[1] ?? "?";
        dispatches.push({
          member: member.slug,
          task,
          key: input.key,
          ask: input.ask,
        });
        // per-task scripts first (the evals' claim order is judged,
        // not scripted), then the FIFO queue, then a shrug
        const reply =
          taskScripts[member.slug]?.[task]?.shift() ??
          scripts[member.slug]?.shift() ??
          "done.";
        // the round lands DURABLY in the session's own log — what the
        // merge's harvest (and recovery) reads
        const list = sessionLogs.get(input.key) ?? [];
        list.push(
          {
            term: member.term,
            key: input.key,
            seq: list.length,
            type: "input",
            at: tick(),
            text: input.ask,
          } as AI.SessionObservation,
          {
            term: member.term,
            key: input.key,
            seq: list.length + 1,
            type: "assistant",
            at: tick(),
            text: reply,
          } as AI.SessionObservation,
        );
        sessionLogs.set(input.key, list);
        return reply;
      }),
    // the live seam dedupes by digest tip; the fake mirrors it with
    // one constant tip per term
    deliverDigest: (member: DeskMember, key) =>
      Effect.sync(() => {
        digests.push({ term: member.term, key });
        if (
          !digestSends.some(
            (sent) => sent.term === member.term && sent.key === key,
          )
        ) {
          digestSends.push({ term: member.term, key });
        }
      }),
    deskKey: (queue, member) => `root::tasks::${queue}::${member.slug}`,
    // the fork: register an empty log under the clone's key — the
    // scripted world's stand-in for "born at the trunk's tip"
    branch: (ref, options) =>
      Effect.sync(() => {
        branches.push({ ref, key: options.key });
        if (!sessionLogs.has(options.key)) sessionLogs.set(options.key, []);
        return { session: options.key, ref: `${options.key}@0` };
      }),
    send: (member: DeskMember, key, text) =>
      Effect.sync(() => {
        merges.push({ term: member.term, key, text });
      }),
    // the observer, scripted: one constant distillation per transcript
    observe: (transcript) =>
      Effect.sync(() => {
        observed.push(transcript);
        return "- 🟡 clone learnings";
      }),
    budget: { maxWorkingDesks: options?.maxWorkingDesks ?? 4 },
    active: new Set<string>(),
  };

  return {
    deps,
    posts,
    dispatches,
    digests,
    digestSends,
    sessionLog,
    branches,
    merges,
    observed,
    /** The desk's width dial — the board's `setWidth`, in memory. */
    setWidth: (desk: string, width: number) => {
      widths[desk] = width;
    },
    /** Seed one session's durable log under its own key. */
    log: (
      key: string,
      entries: ReadonlyArray<{ type: string; at: number; text?: string }>,
    ) => {
      const list = sessionLogs.get(key) ?? [];
      for (const entry of entries) {
        list.push({
          term: "Engineer",
          key,
          seq: list.length,
          ...entry,
        } as AI.SessionObservation);
      }
      sessionLogs.set(key, list);
    },
    /** Every event as `task:kind`, in order — cross-task ordering. */
    timeline: () => events.map((row) => `${row.task}:${row.kind}`),
    /** A task wedged in `working` — claimed durably, waiter dead. */
    seedWorking: (
      id: string,
      title: string,
      desk: string,
      updated: number,
      session?: string,
    ) => {
      rows.set(id, {
        id,
        queue: QUEUE.slug,
        title,
        body: title,
        state: "working",
        tags: [],
        desk,
        ...(session === undefined ? {} : { session }),
        rootPost: `p-${id}`,
        priority: 2,
        at: updated - 10,
        updated,
      });
    },
    file: (
      id: string,
      title: string,
      body: string,
      tags: ReadonlyArray<string> = [],
    ) => {
      rows.set(id, {
        id,
        queue: QUEUE.slug,
        title,
        body,
        state: "ready",
        tags,
        rootPost: `p-${id}`,
        priority: 2,
        at: tick(),
        updated: now,
      });
      event(id, "filed", "sam", JSON.stringify({ state: "ready", tags }));
    },
    answer: (member: string, reply: string) => {
      (scripts[member] ??= []).push(reply);
    },
    /** Script one member's reply for ONE task — order-independent, so
     *  a live-judged scheduler can claim in any order it likes. */
    answerFor: (member: string, task: string, reply: string) => {
      ((taskScripts[member] ??= {})[task] ??= []).push(reply);
    },
    task: (id: string) => toTask(rows.get(id)!),
    /** Every task row — the eval's scoring read. */
    all: () => [...rows.values()].map(toTask),
    kindsOf: (id: string) =>
      events.filter((row) => row.task === id).map((row) => row.kind),
    /** One task's full timeline rows — the eval's scoring read. */
    eventsOf: (id: string) => events.filter((row) => row.task === id),
    recordEvent: (id: string, kind: string, actor: string, data?: string) =>
      event(id, kind, actor, data),
  };
};

export type DeskWorld = ReturnType<typeof deskWorld>;
