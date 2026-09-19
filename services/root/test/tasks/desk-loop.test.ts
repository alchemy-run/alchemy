/**
 * THE DESK LOOP, SCRIPTED — the swarm-harness pattern: the world is
 * explicit code (an in-memory board mirroring TasksDO's semantics, a
 * scripted desk per member, a scripted System One), no network, no
 * driver. Under test: the pump's claim → dispatch → disposition →
 * review cycle, its event trail, and the digest delivery dedupe.
 */
import { RuntimeContext } from "alchemy";
import type * as AI from "alchemy/AI";
import type * as TypeSafe from "alchemy/TypeSafe";
import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import {
  pump,
  type DeskBoard,
  type DeskDeps,
  type DeskMember,
  type QueueSpec,
} from "../../src/tasks/Desks.ts";
import {
  transition,
  type RouteInput,
  type TaskEventRow,
  type TaskRow,
  type TaskState,
} from "../../src/tasks/TasksDO.ts";

const QUEUE: QueueSpec = {
  name: "Engineering",
  slug: "engineering",
  worker: { term: "Engineer", slug: "engineer" },
  reviewer: { term: "Reviewer", slug: "reviewer" },
};

interface WorldPost {
  readonly id: string;
  readonly replyTo?: string;
  readonly author: string;
  readonly text: string;
}

/** The whole fixture, explicitly: rows, a clock counter, per-member
 *  answer scripts, and a System One that answers from code. */
const deskWorld = () => {
  interface Row {
    id: string;
    queue: string;
    title: string;
    body: string;
    state: TaskState;
    tags: ReadonlyArray<string>;
    desk?: string;
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
  const dispatches: Array<{ member: string; task: string; ask: string }> = [];
  const digests: Array<{ term: string; key: string }> = [];
  const digestSends: Array<{ term: string; key: string }> = [];
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
        if (
          [...rows.values()].some(
            (row) => row.state === "working" && row.desk === desk,
          )
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
        event(chosen.id, "assigned", "scheduler", JSON.stringify({ desk }));
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
      Effect.sync(() => {
        const working = [...rows.values()].find(
          (row) => row.state === "working" && row.desk === desk,
        );
        return {
          ...(working === undefined ? {} : { working: toTask(working) }),
          recent: [...rows.values()]
            .filter((row) => row.desk === desk && row.state !== "working")
            .sort((a, b) => b.updated - a.updated)
            .slice(0, 5)
            .map((row) => ({ title: row.title, tags: row.tags })),
        };
      }),
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
  const query = ((questions: Record<string, unknown>, options: {
    state: Record<string, unknown>;
  }) =>
    Effect.sync(() => {
      if ("changes" in questions) {
        const review = String(options.state.review ?? "");
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

  // the desk session's durable log, as recovery reads it — tests
  // seed it to simulate a round that finished with no waiter alive
  const sessionLog: Array<AI.SessionObservation> = [];

  const deps: DeskDeps = {
    query,
    board: () => board,
    history: () => Effect.succeed(sessionLog.slice()),
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
        dispatches.push({ member: member.slug, task, ask: input.ask });
        return scripts[member.slug]?.shift() ?? "done.";
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
    budget: { maxWorkingDesks: 4 },
    active: new Set<string>(),
  };

  return {
    deps,
    posts,
    dispatches,
    digests,
    digestSends,
    sessionLog,
    /** A task wedged in `working` — claimed durably, waiter dead. */
    seedWorking: (id: string, title: string, desk: string, updated: number) => {
      rows.set(id, {
        id,
        queue: QUEUE.slug,
        title,
        body: title,
        state: "working",
        tags: [],
        desk,
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
    task: (id: string) => toTask(rows.get(id)!),
    kindsOf: (id: string) =>
      events.filter((row) => row.task === id).map((row) => row.kind),
    recordEvent: (id: string, kind: string, actor: string, data?: string) =>
      event(id, kind, actor, data),
  };
};

const run = (world: ReturnType<typeof deskWorld>) =>
  Effect.runPromise(
    pump(world.deps, QUEUE).pipe(Effect.provide(RuntimeContext.phantom)),
  );

describe("the desk loop", () => {
  test("two tasks flow claim → complete → review → done, serially", async () => {
    const world = deskWorld();
    world.file(
      "t-1",
      "fix(r2): CORS drift",
      "Bucket CORS rules drift on adopt.",
      ["cloudflare"],
    );
    world.file("t-2", "fix(do): alarm eviction", "Alarms drop on eviction.", [
      "cloudflare",
    ]);

    world.answer(
      "engineer",
      "Reproduced and fixed in Bucket.ts.\nDISPOSITION: complete — CORS diff now reads observed rules",
    );
    world.answer("reviewer", "LGTM — the diff reads observed state.");
    world.answer(
      "engineer",
      "Re-registered the alarm in the constructor.\nDISPOSITION: complete — alarm re-registration on wake",
    );
    world.answer(
      "reviewer",
      "Changes needed: the eviction test is racy — fix the retry bound.",
    );
    world.answer(
      "engineer",
      "Bounded the retry; test deterministic.\nDISPOSITION: complete — addressed the review",
    );
    world.answer("reviewer", "LGTM now.");

    await run(world);

    // both tasks reached done
    expect(world.task("t-1").state).toBe("done");
    expect(world.task("t-2").state).toBe("done");

    // ONE desk, SERIAL: the dispatch order is the whole story
    expect(
      world.dispatches.map((entry) => `${entry.member}:${entry.task}`),
    ).toEqual([
      "engineer:t-1",
      "reviewer:t-1",
      "engineer:t-2",
      "reviewer:t-2",
      "engineer:t-2",
      "reviewer:t-2",
    ]);

    // the timeline: t-2 bounced once and closed approved
    expect(world.kindsOf("t-2")).toEqual([
      "filed",
      "assigned",
      "started",
      "posted",
      "review_requested",
      "assigned",
      "started",
      "posted",
      "changes_requested",
      "assigned",
      "started",
      "posted",
      "review_requested",
      "assigned",
      "started",
      "posted",
      "approved",
    ]);
    expect(world.kindsOf("t-1").at(-1)).toBe("approved");

    // replies landed as posts in each task's thread
    expect(
      world.posts.filter((post) => post.replyTo === "p-t-1").length,
    ).toBeGreaterThanOrEqual(2);

    // the task CARD wears its tags — the desk reads the area
    expect(world.dispatches[0]!.ask).toContain(
      "[task t-1 · queue engineering · tags cloudflare]",
    );

    // the digest: delivered on every claim, SENT once per desk
    expect(world.digests.length).toBe(6);
    expect(world.digestSends).toEqual([
      { term: "Engineer", key: "root::tasks::engineering::engineer" },
      { term: "Reviewer", key: "root::tasks::engineering::reviewer" },
    ]);
  });

  test("a wedged working task is recovered from the session's log", async () => {
    const world = deskWorld();
    // claimed at t=100; the isolate died awaiting the reply — the DO
    // session finished the round durably (reply at 200, parked at 210)
    world.seedWorking("t-w", "wedge me", "engineer", 100);
    const row = (partial: {
      type: string;
      at: number;
      text?: string;
    }): AI.SessionObservation =>
      ({
        term: "Engineer",
        key: "root::tasks::engineering::engineer",
        seq: world.sessionLog.length,
        ...partial,
      }) as AI.SessionObservation;
    world.sessionLog.push(
      row({ type: "input", at: 110 }),
      row({
        type: "assistant",
        at: 200,
        text: "Blocked on entitlements.\nDISPOSITION: park — no access",
      }),
      row({ type: "parked", at: 210 }),
    );
    await run(world);
    expect(world.task("t-w").state).toBe("parked");
    // the harvested reply landed in the task's thread
    expect(
      world.posts.some(
        (post) => post.author === "engineer" && /DISPOSITION: park/.test(post.text),
      ),
    ).toBe(true);
    // no new dispatch happened — recovery harvests, never re-runs
    expect(world.dispatches.filter((d) => d.member === "engineer")).toHaveLength(0);
  });

  test("a wedged task whose round never ran is re-queued", async () => {
    const world = deskWorld();
    world.seedWorking("t-n", "never started", "engineer", 500);
    // the session last parked BEFORE the claim — the ask never landed
    world.sessionLog.push({
      term: "Engineer",
      key: "root::tasks::engineering::engineer",
      seq: 0,
      type: "parked",
      at: 400,
    } as AI.SessionObservation);
    // the freed desk immediately re-claims it, so script the round
    world.answer(
      "engineer",
      "done.\nDISPOSITION: complete — trivial",
    );
    world.answer("reviewer", "approve");
    await run(world);
    // re-queued, then worked to completion by the normal loop
    expect(["ready", "review", "done"]).toContain(world.task("t-n").state);
    expect(world.kindsOf("t-n")).toContain("routed");
  });

  test("repeated recoveries park the task as poisoned — no churn loop", async () => {
    const world = deskWorld();
    world.seedWorking("t-p", "poisoned", "engineer", 500);
    // two recoveries already on the record — the third parks instead
    world.recordEvent("t-p", "routed", "engineer", "recovered: the round ended without a reply — re-queued");
    world.recordEvent("t-p", "routed", "engineer", "recovered: the round ended without a reply — re-queued");
    world.sessionLog.push({
      term: "Engineer",
      key: "root::tasks::engineering::engineer",
      seq: 0,
      type: "parked",
      at: 400,
    } as AI.SessionObservation);
    await run(world);
    expect(world.task("t-p").state).toBe("parked");
    expect(world.task("t-p").parkedReason).toContain("watchdog");
    // and no fresh dispatch was burned on the poisoned pair
    expect(world.dispatches.filter((d) => d.member === "engineer")).toHaveLength(0);
  });

  test("a round busy past the TTL is parked by the watchdog", async () => {
    const world = deskWorld();
    // claimed 31 real minutes ago; the session log shows no park —
    // to every other check the desk just looks busy, forever
    world.seedWorking("t-t", "hung round", "engineer", Date.now() - 31 * 60_000);
    await run(world);
    expect(world.task("t-t").state).toBe("parked");
    expect(world.task("t-t").parkedReason).toContain("watchdog");
  });

  test("park and handoff dispositions land where they say", async () => {
    const world = deskWorld();
    world.file(
      "t-park",
      "feat(magic): magic transit resource",
      "Requires the Magic Transit entitlement.",
      ["cloudflare"],
    );
    world.file(
      "t-hand",
      "fix(infra): dns registrar renewal",
      "The registrar renewal is manual, human-owned work.",
      ["org"],
    );
    world.answer(
      "engineer",
      "Probed the API — code 1012, not onboarded.\nDISPOSITION: park — blocked on the Magic Transit entitlement",
    );
    world.answer(
      "engineer",
      "This is human-owned registrar work, not desk work.\nDISPOSITION: handoff — belongs to a human owner",
    );

    await run(world);

    expect(world.task("t-park").state).toBe("parked");
    expect(world.task("t-park").parkedReason).toContain("entitlement");
    expect(world.kindsOf("t-park")).toContain("parked");

    // handoff → back to the inbox for re-routing
    expect(world.task("t-hand").state).toBe("inbox");
    expect(world.kindsOf("t-hand").at(-1)).toBe("routed");

    // the reviewer never woke — nothing reached review
    expect(
      world.dispatches.filter((entry) => entry.member === "reviewer"),
    ).toEqual([]);
  });

  test("a reply without the line is judged, not dropped", async () => {
    const world = deskWorld();
    world.file("t-j", "fix(kv): ttl rounding", "TTLs round down a full minute.");
    world.answer("engineer", "Fixed the rounding and added a test."); // no line
    world.answer("reviewer", "LGTM.");

    await run(world);

    // the scripted Choice judged `complete` → review → approved → done
    expect(world.task("t-j").state).toBe("done");
    expect(world.kindsOf("t-j")).toContain("review_requested");
  });
});
