/**
 * The identity seam (Phase 3): `AI.Identity.observational` gives an
 * agent a SELF — a reserved session of the same term that learnings
 * journal UP into and whose newest observational doc (the digest)
 * flows back DOWN.
 *
 * - `journal()` frames entries `[journal from <term>/<key>]` and
 *   lands them on the self session as a waking input (author
 *   `journal`);
 * - `digest()` answers the self session's newest observational doc;
 * - `deliverDigest()` sends the digest quiet to a target session,
 *   once per tip;
 * - the bundled Compaction policy forwards the observer's `## Journal`
 *   learnings to the self session end-to-end.
 */
import * as AI from "@/AI/index.ts";
import { DriverLocal } from "@/AI/DriverLocal.ts";
import { ThreadStorage } from "@/AI/ThreadStorage.ts";
import { ThreadStorageMemory } from "@/AI/ThreadStorageMemory.ts";
import { RuntimeContext } from "@/RuntimeContext.ts";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import {
  Researcher,
  ResearcherCharter,
  Search,
} from "./fixtures/researcher.ts";
import * as Model from "./fixtures/ScriptedModel.ts";

const user = (text: string) =>
  ({ role: "user", content: [{ type: "text", text }] }) as const;

/** The driver + identity assembly over ONE memory store — the layers
 *  are built per test but share module references, so the test reads
 *  the same rows the driver writes. */
const assemble = (
  model: Model.ScriptedModel,
  options?: AI.IdentityOptions,
): {
  readonly driver: Layer.Layer<any, any, any>;
  readonly identity: Layer.Layer<any, any, any>;
} => {
  const driver = DriverLocal.pipe(
    Layer.provide(ThreadStorageMemory),
    Layer.provide(model.layer),
  );
  const identity = AI.Identity.observational(options).pipe(
    Layer.provide(driver),
    Layer.provide(ThreadStorageMemory),
  ) as Layer.Layer<any, any, any>;
  return { driver, identity };
};

const interpret = (term: AI.Interpretable, charter: AI.Charter) =>
  Effect.orDie(
    Effect.flatMap(AI.Driver, (driver) => driver.interpret(term, charter)),
  );

/** Inert search physics — the charter splices it, so a layer must
 *  answer even in tests whose script never calls it. */
const stubSearch = Layer.succeed(Search, ((_: { query: string }) =>
  Effect.succeed({ results: "stub" })) as never);

/** Poll the self session's durable log until an `input` row lands —
 *  the journal send wakes the self asynchronously. */
const awaitSelfInput = (selfKey: string) =>
  Effect.gen(function* () {
    const sessions = yield* AI.Sessions;
    const observations = yield* sessions.history("Researcher", selfKey).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("50 millis"),
        until: (rows) => rows.some((row) => row.type === "input"),
        times: 100,
      }),
    );
    const input = observations.find((row) => row.type === "input");
    expect(input).toBeDefined();
    return input as Extract<AI.SessionObservation, { type: "input" }>;
  });

describe("identity", () => {
  it.effect(
    "journal() lands framed entries on the self session as a waking input",
    () => {
      const model = Model.make([
        // round 1: the researcher searches — the physics journals
        () => [
          Model.toolCall("search", { query: "go" }),
          Model.finish("tool-calls"),
        ],
        // every later sampling (the round's wrap-up, the woken self)
        // quiesces
        () => [Model.text("ok"), Model.finish()],
      ]);
      const { driver, identity } = assemble(model);
      const journalingSearch = Layer.effect(
        Search,
        Effect.gen(function* () {
          const self = yield* AI.Identity;
          return ((_: { query: string }) =>
            Effect.gen(function* () {
              yield* self.journal(
                "alchemy compiles infrastructure from Effect programs",
              );
              return { results: "journaled" };
            })) as never;
        }),
      ).pipe(Layer.provide(identity));
      return Effect.gen(function* () {
        const researcher = yield* interpret(Researcher, ResearcherCharter);
        yield* researcher.dispatch("first", { key: "journal-case" });

        const input = yield* awaitSelfInput("self");
        expect(input.author).toBe("journal");
        expect(input.text).toContain("[journal from Researcher/journal-case]");
        expect(input.text).toContain(
          "- alchemy compiles infrastructure from Effect programs",
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            driver,
            identity,
            journalingSearch,
            ThreadStorageMemory,
            RuntimeContext.phantom,
          ),
        ),
      );
    },
  );

  it.effect("digest() reads the newest observational doc of the self", () => {
    const model = Model.make([() => [Model.text("ok"), Model.finish()]]);
    const { driver, identity } = assemble(model);
    return Effect.gen(function* () {
      const storage = yield* ThreadStorage;
      const handle = yield* storage.open("Researcher", "self");
      const self = yield* AI.Identity;

      // a self that never compacted has no digest
      expect(yield* self.digest("Researcher")).toBeUndefined();

      yield* handle.appendMessages([user("raw journal history")]);
      yield* handle.advanceGeneration({
        author: "observational",
        kind: "observe",
        doc: "### 2026-09-18\n- 🔴 first distilled learning",
        dropped: 1,
        tokensBefore: 8,
        tokensAfter: 4,
        surface: [user("log head")],
      });
      const first = yield* self.digest("Researcher");
      expect(first).toEqual({
        tip: "Researcher/self@1",
        doc: "### 2026-09-18\n- 🔴 first distilled learning",
      });

      // a reflection supersedes the observation — the digest is the
      // NEWEST observational doc
      yield* handle.advanceGeneration({
        author: "observational",
        kind: "reflect",
        doc: "### 2026-09-18\n- 🔴 REFLECTED learning",
        dropped: 0,
        tokensBefore: 4,
        tokensAfter: 2,
        surface: [user("log head 2")],
      });
      const second = yield* self.digest("Researcher");
      expect(second?.tip).toBe("Researcher/self@2");
      expect(second?.doc).toContain("REFLECTED");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          driver,
          identity,
          ThreadStorageMemory,
          RuntimeContext.phantom,
        ),
      ),
    );
  });

  it.effect("deliverDigest sends once per tip, quiet, to the target", () => {
    const model = Model.make([() => [Model.text("ok"), Model.finish()]]);
    const { driver, identity } = assemble(model);
    return Effect.gen(function* () {
      const storage = yield* ThreadStorage;
      const self = yield* storage.open("Researcher", "self");
      yield* self.advanceGeneration({
        author: "observational",
        kind: "observe",
        doc: "### 2026-09-18\n- 🔴 digest v1",
        dropped: 0,
        tokensBefore: 4,
        tokensAfter: 2,
        surface: [user("log head")],
      });
      // the send addresses the term's engine — interpret it first
      yield* interpret(Researcher, ResearcherCharter);

      // first delivery lands ONE quiet row; the same tip re-delivers
      // nothing
      yield* AI.Identity.deliverDigest("Researcher", "desk-1");
      yield* AI.Identity.deliverDigest("Researcher", "desk-1");
      const desk = yield* storage.open("Researcher", "desk-1");
      const rows = yield* desk.listInbox;
      expect(rows.length).toBe(1);
      expect(rows[0]!.quiet).toBe(true);
      expect(rows[0]!.message.author).toBe("self");
      expect(rows[0]!.message.content).toContain("[self Researcher/self@1]");
      expect(rows[0]!.message.content).toContain("digest v1");

      // a tip advance is a NEW delivery
      yield* self.advanceGeneration({
        author: "observational",
        kind: "reflect",
        doc: "### 2026-09-18\n- 🔴 digest v2",
        dropped: 0,
        tokensBefore: 2,
        tokensAfter: 1,
        surface: [user("log head 2")],
      });
      yield* AI.Identity.deliverDigest("Researcher", "desk-1");
      const advanced = yield* desk.listInbox;
      expect(advanced.length).toBe(2);
      expect(advanced[1]!.message.content).toContain(
        "[self Researcher/self@2]",
      );
      expect(advanced[1]!.message.content).toContain("digest v2");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          driver,
          identity,
          stubSearch,
          ThreadStorageMemory,
          RuntimeContext.phantom,
        ),
      ),
    );
  });

  it.effect(
    "the bundled policy forwards 🔴 journal lines to the self end-to-end",
    () => {
      const longAnswer = `Alchemy is Infrastructure-as-Effects. ${"Detail. ".repeat(50)}`;
      const observerOutput = [
        "### 2026-09-18",
        "- 🔴 researching alchemy for the user",
        "- ✅ answered the opening ask",
        "",
        "## Journal",
        "- 🔴 alchemy compiles infrastructure from Effect programs",
      ].join("\n");
      const model = Model.make([
        // round 1: a long answer pushes the unobserved span over the
        // threshold
        () => [Model.text(longAnswer), Model.finish()],
        // the observer's generateText — log + journal
        () => [Model.text(observerOutput), Model.finish()],
        // round 2 (and the woken self) sample over observed threads
        () => [Model.text("second answer"), Model.finish()],
      ]);
      const { driver, identity } = assemble(model, {
        observeAt: 40,
        keepTail: 0.5,
      });
      return Effect.gen(function* () {
        const researcher = yield* interpret(Researcher, ResearcherCharter);
        yield* researcher.dispatch("first question", { key: "observe-case" });
        yield* researcher.dispatch("second question", { key: "observe-case" });

        // the desk's generation carries the log — journal lines
        // climbed instead of staying
        const storage = yield* ThreadStorage;
        const handle = yield* storage.open("Researcher", "observe-case");
        const lineage = yield* handle.lineage;
        expect(lineage.length).toBe(1);
        expect(lineage[0]!.kind).toBe("observe");
        expect(lineage[0]!.doc).toContain("researching alchemy");
        expect(lineage[0]!.doc).not.toContain("compiles infrastructure");

        // ...and landed on the self session, framed with their origin
        const input = yield* awaitSelfInput("self");
        expect(input.author).toBe("journal");
        expect(input.text).toContain("[journal from Researcher/observe-case]");
        expect(input.text).toContain(
          "- 🔴 alchemy compiles infrastructure from Effect programs",
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            driver,
            identity,
            stubSearch,
            ThreadStorageMemory,
            RuntimeContext.phantom,
          ),
        ),
      );
    },
  );
});
