/**
 * THE DESK LOOP, SCRIPTED — the swarm-harness pattern: the world is
 * explicit code (an in-memory board mirroring TasksDO's semantics, a
 * scripted desk per member, a scripted System One), no network, no
 * driver. Under test: the pump's claim → dispatch → disposition →
 * review cycle, its event trail, and the digest delivery dedupe.
 *
 * The world itself lives in eval/world.ts — the eval harness
 * (eval/run.ts) drives the SAME fixture with real TypeSafe judging.
 */
import { RuntimeContext } from "alchemy";
import type * as AI from "alchemy/AI";
import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { pump } from "../../src/tasks/Desks.ts";
import { deskWorld, QUEUE, TRUNK } from "../../eval/world.ts";

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

    // width 1 stays LINEAR: every round ran at the trunk — no clone
    // forked, nothing merged
    expect(world.branches).toEqual([]);
    expect(world.merges).toEqual([]);
  });

  test("width 2: two tasks claimed together — the trunk plus a branched clone that merges home", async () => {
    const world = deskWorld();
    world.setWidth("engineer", 2);
    world.file("t-1", "fix(kv): ttl clamp", "Clamp negative TTLs.");
    world.file("t-2", "fix(do): stub cache", "Stub cache leaks per call.");
    world.answer("engineer", "Clamped.\nDISPOSITION: complete — ttl clamped");
    world.answer("engineer", "Cached.\nDISPOSITION: complete — stub cached");
    world.answer("reviewer", "LGTM.");
    world.answer("reviewer", "LGTM.");

    await run(world);

    expect(world.task("t-1").state).toBe("done");
    expect(world.task("t-2").state).toBe("done");

    // ONE fork: slot one held the trunk, slot two branched a clone
    // at the trunk's tip (no compactions yet — the birth generation)
    expect(world.branches).toHaveLength(1);
    expect(world.branches[0]!.ref).toBe(`Engineer/${TRUNK}@0`);
    const clone = world.branches[0]!.key;
    expect(clone).toMatch(
      /^root::tasks::engineering::engineer#[a-z0-9]+(-\d+)?$/,
    );

    // the two engineer rounds ran at DIFFERENT sessions
    expect(
      world.dispatches
        .filter((entry) => entry.member === "engineer")
        .map((entry) => `${entry.key} → ${entry.task}`)
        .sort(),
    ).toEqual([`${TRUNK} → t-1`, `${clone} → t-2`].sort());

    // claimed CONCURRENTLY: both starts landed before either settle
    const timeline = world.timeline();
    const settles = [
      timeline.indexOf("t-1:review_requested"),
      timeline.indexOf("t-2:review_requested"),
    ];
    expect(timeline.indexOf("t-1:started")).toBeLessThan(Math.min(...settles));
    expect(timeline.indexOf("t-2:started")).toBeLessThan(Math.min(...settles));

    // the clone's settle merged home: exactly ONE quiet send to the
    // TRUNK carrying the distilled notes; the trunk task merged nothing
    expect(world.merges).toEqual([
      {
        term: "Engineer",
        key: TRUNK,
        text: `[merge from ${clone} · t-2]\n- 🟡 clone learnings`,
      },
    ]);
    expect(world.observed).toHaveLength(1);
  });

  test("recovery: two stuck tasks on one desk each recover against their own session's log", async () => {
    const world = deskWorld();
    world.setWidth("engineer", 2);
    const clone = `${TRUNK}#abc`;
    world.seedWorking("t-a", "stuck on the trunk", "engineer", 100, TRUNK);
    world.seedWorking("t-b", "stuck on a clone", "engineer", 100, clone);
    // each session finished its round durably — with DIFFERENT ends
    world.log(TRUNK, [
      { type: "input", at: 110, text: "work t-a" },
      {
        type: "assistant",
        at: 200,
        text: "Trunk done.\nDISPOSITION: complete — trunk result",
      },
      { type: "parked", at: 210 },
    ]);
    world.log(clone, [
      { type: "input", at: 120, text: "work t-b" },
      {
        type: "assistant",
        at: 220,
        text: "Blocked.\nDISPOSITION: park — no access to the entitlement",
      },
      { type: "parked", at: 230 },
    ]);
    world.answer("reviewer", "LGTM.");

    await run(world);

    // t-a's TRUNK log said complete → review → approved → done;
    // t-b's CLONE log said park — one settle per session, never mixed
    expect(world.task("t-a").state).toBe("done");
    expect(world.task("t-b").state).toBe("parked");
    expect(world.task("t-b").parkedReason).toContain("entitlement");
    // recovery harvests, never re-runs
    expect(
      world.dispatches.filter((entry) => entry.member === "engineer"),
    ).toHaveLength(0);
    // the clone's recovered settle still merged home
    expect(world.merges).toHaveLength(1);
    expect(
      world.merges[0]!.text.startsWith(`[merge from ${clone} · t-b]`),
    ).toBe(true);
    expect(world.merges[0]!.key).toBe(TRUNK);
  });

  test("the org budget counts clones — a saturated org narrows a wide desk", async () => {
    const world = deskWorld({ maxWorkingDesks: 1 });
    world.setWidth("engineer", 2);
    world.file("t-1", "fix(a): first", "first");
    world.file("t-2", "fix(b): second", "second");
    world.answer("engineer", "done.\nDISPOSITION: complete — a");
    world.answer("engineer", "done.\nDISPOSITION: complete — b");
    world.answer("reviewer", "LGTM.");
    world.answer("reviewer", "LGTM.");

    await run(world);

    // both flowed to done — but SERIALLY: the second slot would have
    // busted the org budget, so no clone was ever forked
    expect(world.task("t-1").state).toBe("done");
    expect(world.task("t-2").state).toBe("done");
    expect(world.branches).toEqual([]);
    expect(
      world.dispatches
        .filter((entry) => entry.member === "engineer")
        .map((entry) => entry.key),
    ).toEqual([TRUNK, TRUNK]);
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
