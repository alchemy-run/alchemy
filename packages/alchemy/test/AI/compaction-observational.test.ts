/**
 * The observational compaction policy (Phase 2):
 *
 * - below `observeAt` the policy declines — no generation advances;
 * - crossing `observeAt` runs the OBSERVER: the new generation's kind
 *   is "observe", its doc is the observation log, its surface is the
 *   log note plus the verbatim tail, and the `## Journal` bullets go
 *   to the journal hook without staying in the log;
 * - a log past `reflectAt` runs the REFLECTOR (with the
 *   retry-once-if-not-smaller pressure guard): kind "reflect", doc =
 *   the rewritten log, every other surface row untouched;
 * - the `Recall` tool pages the raw messages a generation shadowed.
 */
import * as AI from "@/AI/index.ts";
import {
  applyCompactionPlan,
  elideOrphanToolResults,
} from "@/AI/DriverCore.ts";
import { DriverLocal } from "@/AI/DriverLocal.ts";
import { ThreadStorage } from "@/AI/ThreadStorage.ts";
import { ThreadStorageMemory } from "@/AI/ThreadStorageMemory.ts";
import { RuntimeContext } from "@/RuntimeContext.ts";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  Researcher,
  ResearcherCharter,
  Search,
} from "./fixtures/researcher.ts";
import * as Model from "./fixtures/ScriptedModel.ts";

const user = (text: string) =>
  ({ role: "user", content: [{ type: "text", text }] }) as const;

const testLayer = (
  model: Model.ScriptedModel,
  ...capabilities: Array<Layer.Layer<never, any, any>>
) =>
  Layer.mergeAll(
    DriverLocal.pipe(
      Layer.provide(ThreadStorageMemory),
      Layer.provide(model.layer),
    ),
    // the same memoized reference the driver builds on — the test
    // reads the ledger out-of-band through the same store
    ThreadStorageMemory,
    RuntimeContext.phantom,
    ...capabilities,
  );

const interpret = (term: AI.Interpretable, charter: AI.Charter) =>
  Effect.orDie(
    Effect.flatMap(AI.Driver, (driver) => driver.interpret(term, charter)),
  );

/** Inert search physics — the charter splices it, so a layer must
 *  answer even in tests whose script never calls it. */
const stubSearch = Layer.succeed(Search, ((_: { query: string }) =>
  Effect.succeed({ results: "stub" })) as never);

/** Search physics that requests a compaction, then answers. */
const compactingSearch = (plan: AI.CompactPlan) =>
  Layer.succeed(Search, ((_: { query: string }) =>
    Effect.gen(function* () {
      const thread = yield* AI.Thread;
      yield* thread.compact(plan);
      return { results: "compaction requested" };
    })) as never);

describe("observational compaction", () => {
  it.effect("below observeAt the policy declines — no generation", () => {
    const model = Model.make([
      () => [Model.text("one"), Model.finish()],
      () => [Model.text("two"), Model.finish()],
    ]);
    return Effect.gen(function* () {
      const researcher = yield* interpret(Researcher, ResearcherCharter);
      yield* researcher.dispatch("first", { key: "quiet-case" });
      const second = yield* researcher.dispatch("second", {
        key: "quiet-case",
      });
      expect(second).toBe("two");
      // two samplings, no observer call
      expect(model.calls.length).toBe(2);

      const storage = yield* ThreadStorage;
      const handle = yield* storage.open("Researcher", "quiet-case");
      expect(yield* handle.lineage).toEqual([]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        testLayer(
          model,
          stubSearch,
          AI.Compaction.observational({ observeAt: 10_000 }) as Layer.Layer<
            never,
            any,
            any
          >,
        ),
      ),
    );
  });

  it.effect(
    "crossing observeAt observes — log heads the surface, journal climbs",
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
        // the observer's generateText — distills the log + journal
        () => [Model.text(observerOutput), Model.finish()],
        // round 2 samples over the observed thread
        () => [Model.text("second answer"), Model.finish()],
      ]);
      const journaled: Array<string> = [];
      return Effect.gen(function* () {
        const researcher = yield* interpret(Researcher, ResearcherCharter);
        yield* researcher.dispatch("first question", { key: "observe-case" });
        const second = yield* researcher.dispatch("second question", {
          key: "observe-case",
        });
        expect(second).toBe("second answer");
        // sampling, observer, sampling — three model calls
        expect(model.calls.length).toBe(3);
        // the observer saw the unobserved history
        expect(Model.promptText(model.calls[1]!)).toContain("first question");

        const storage = yield* ThreadStorage;
        const handle = yield* storage.open("Researcher", "observe-case");
        const lineage = yield* handle.lineage;
        expect(lineage.length).toBe(1);
        const record = lineage[0]!;
        expect(record.kind).toBe("observe");
        expect(record.author).toBe("observational");
        // the doc IS the log — journal lines are forwarded, not kept
        expect(record.doc).toContain("🔴 researching alchemy for the user");
        expect(record.doc).not.toContain("Journal");
        expect(record.doc).not.toContain("compiles infrastructure");
        expect(journaled).toEqual([
          "🔴 alchemy compiles infrastructure from Effect programs",
        ]);

        // surface = [log note, …verbatim tail]; older rows shadowed
        const live = yield* handle.messages;
        expect(JSON.stringify(live[0])).toContain("Observation log");
        expect(JSON.stringify(live[0])).toContain(
          "🔴 researching alchemy for the user",
        );
        expect(JSON.stringify(live[1])).toContain("Detail.");
        expect(JSON.stringify(live)).not.toContain("first question");
        expect(JSON.stringify(yield* handle.messagesAt(0))).toContain(
          "first question",
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          testLayer(
            model,
            stubSearch,
            AI.Compaction.observational({
              observeAt: 40,
              keepTail: 0.5,
              journal: (entries) =>
                Effect.sync(() => {
                  journaled.push(...entries);
                }),
            }) as Layer.Layer<never, any, any>,
          ),
        ),
      );
    },
  );

  it.effect(
    "a log past reflectAt reflects — whole-log rewrite under pressure",
    () => {
      const hugeLog =
        "### 2026-09-17\n" +
        "- 🟡 a fine-grained detail line about the codebase\n".repeat(120);
      const reflected = "### 2026-09-17\n- 🔴 REFLECTED LOG of the codebase";
      const model = Model.make([
        // reflector attempt 1: NOT smaller — trips the pressure retry
        () => [Model.text(`${hugeLog}\n- 🟢 even more`), Model.finish()],
        // reflector attempt 2: the dense rewrite
        () => [Model.text(reflected), Model.finish()],
        // the round samples over the reflected thread
        () => [Model.text("after reflect"), Model.finish()],
      ]);
      return Effect.gen(function* () {
        // seed a session whose tip is an observe generation carrying
        // an oversized log
        const storage = yield* ThreadStorage;
        const seeded = yield* storage.open("Researcher", "reflect-case");
        yield* seeded.appendMessages([user("raw history under the log")]);
        yield* seeded.advanceGeneration({
          author: "observational",
          kind: "observe",
          doc: hugeLog,
          dropped: 1,
          tokensBefore: 8,
          tokensAfter: 4,
          surface: [user("log head")],
        });

        const researcher = yield* interpret(Researcher, ResearcherCharter);
        const answer = yield* researcher.dispatch("keep going", {
          key: "reflect-case",
        });
        expect(answer).toBe("after reflect");
        // reflector, reflector retry, sampling — three model calls
        expect(model.calls.length).toBe(3);
        expect(Model.promptText(model.calls[1]!)).toContain(
          "previous rewrite was not smaller",
        );

        const lineage = yield* seeded.lineage;
        expect(lineage.length).toBe(2);
        const record = lineage[0]!;
        expect(record.kind).toBe("reflect");
        expect(record.author).toBe("observational");
        expect(record.doc).toBe(reflected);

        const live = yield* seeded.messages;
        expect(JSON.stringify(live[0])).toContain("REFLECTED LOG");
        expect(JSON.stringify(live)).toContain("keep going");
        // the pre-reflection surface stays addressable
        expect(JSON.stringify(yield* seeded.messagesAt(1))).toContain(
          "log head",
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          testLayer(
            model,
            stubSearch,
            AI.Compaction.observational({
              observeAt: 10_000,
              reflectAt: 100,
            }) as Layer.Layer<never, any, any>,
          ),
        ),
      );
    },
  );

  it.effect("Recall pages the raw messages a generation shadowed", () => {
    const RecallCharter = AI.fragment`
You are a careful researcher. Use ${Search} to look things up and
${AI.Recall} to page history that compaction shadowed.`;
    const model = Model.make([
      // round 1: plain answer — seeds the row the reset will shadow
      () => [Model.text("noted"), Model.finish()],
      // round 2: the tool requests the reset…
      () => [
        Model.toolCall("search", { query: "go" }),
        Model.finish("tool-calls"),
      ],
      // …then the model recalls the shadowed birth generation…
      () => [
        Model.toolCall("recall", { ref: "Researcher/recall-case@0" }),
        Model.finish("tool-calls"),
      ],
      // …and answers with the recovered detail in context
      () => [Model.text("recalled"), Model.finish()],
    ]);
    const search = compactingSearch({ reset: { summary: "SUMMARY" } });
    return Effect.gen(function* () {
      const researcher = yield* interpret(Researcher, RecallCharter);
      yield* researcher.dispatch("remember X_SECRET_X please", {
        key: "recall-case",
      });
      const answer = yield* researcher.dispatch("search now", {
        key: "recall-case",
      });
      expect(answer).toBe("recalled");

      // the reset shadowed the secret out of the live surface…
      const storage = yield* ThreadStorage;
      const handle = yield* storage.open("Researcher", "recall-case");
      const finalPrompt = Model.promptText(model.calls[3]!);
      // …but the recall result put the original text back in front of
      // the model, addressed by its ref
      expect(finalPrompt).toContain("Researcher/recall-case@0");
      expect(finalPrompt).toContain("X_SECRET_X");
      expect(JSON.stringify(yield* handle.messagesAt(0))).toContain(
        "X_SECRET_X",
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        testLayer(
          model,
          search,
          AI.RecallLive.pipe(Layer.provide(ThreadStorageMemory)),
        ),
      ),
    );
  });
});

const assistantCall = (id: string) =>
  ({
    role: "assistant",
    content: [
      { type: "tool-call", id, name: "search", params: { query: "q" } },
    ],
  }) as const;

const toolResult = (id: string) =>
  ({
    role: "tool",
    content: [
      {
        type: "tool-result",
        id,
        name: "search",
        isFailure: false,
        result: "hits",
      },
    ],
  }) as const;

/** Every tool-result must follow its call and every call must be
 *  answered — the shape every provider requires of a surface. */
const expectPairBalanced = (
  rows: ReadonlyArray<{
    readonly role: string;
    readonly content: string | ReadonlyArray<unknown>;
  }>,
) => {
  const calls = new Set<string>();
  const answered = new Set<string>();
  for (const row of rows) {
    if (typeof row.content === "string") continue;
    for (const part of row.content as ReadonlyArray<{
      readonly type: string;
      readonly id?: string;
    }>) {
      if (part.type === "tool-call") calls.add(part.id!);
      if (part.type === "tool-result") {
        expect(calls.has(part.id!)).toBe(true);
        answered.add(part.id!);
      }
    }
  }
  for (const id of calls) expect(answered.has(id)).toBe(true);
};

describe("pair-balanced compaction", () => {
  it.effect("an observe tail landing mid-pair walks back onto the call", () =>
    Effect.gen(function* () {
      const storage = yield* ThreadStorage;
      const handle = yield* storage.open("Researcher", "pair-observe");
      yield* handle.appendMessages([
        user("first question"),
        assistantCall("call-1"),
        toolResult("call-1"),
        user("second question"),
        user("third question"),
      ]);
      // keepTail 3 would start the tail ON the tool row — its call
      // shadowed, the provider would reject; the balanced start
      // walks back onto the assistant turn that issued the call
      yield* applyCompactionPlan(handle, {
        observe: { log: "- 🔴 the log", keepTail: 3, kind: "observe" },
      });
      const live = yield* handle.messages;
      expect(JSON.stringify(live[0])).toContain("Observation log");
      expect(live[1]!.role).toBe("assistant");
      expectPairBalanced(live);
      // the pair rode the tail whole; older rows are shadowed
      expect(JSON.stringify(live)).toContain("call-1");
      expect(JSON.stringify(live)).not.toContain("first question");
    }).pipe(Effect.scoped, Effect.provide(ThreadStorageMemory)),
  );

  it.effect("a drop that splits a pair widens to the whole pair", () =>
    Effect.gen(function* () {
      const storage = yield* ThreadStorage;

      // dropping only the CALL drops its result too
      const first = yield* storage.open("Researcher", "pair-drop-call");
      yield* first.appendMessages([
        user("old question"),
        assistantCall("call-2"),
        toolResult("call-2"),
        user("recent question"),
      ]);
      yield* applyCompactionPlan(first, {
        drop: (_entry, index) => index === 1,
      });
      const afterCallDrop = yield* first.messages;
      expectPairBalanced(afterCallDrop);
      expect(JSON.stringify(afterCallDrop)).not.toContain("call-2");
      expect(JSON.stringify(afterCallDrop)).toContain("recent question");

      // dropping only the RESULT drops its call too
      const second = yield* storage.open("Researcher", "pair-drop-result");
      yield* second.appendMessages([
        user("old question"),
        assistantCall("call-3"),
        toolResult("call-3"),
        user("recent question"),
      ]);
      yield* applyCompactionPlan(second, {
        drop: (_entry, index) => index === 2,
      });
      const afterResultDrop = yield* second.messages;
      expectPairBalanced(afterResultDrop);
      expect(JSON.stringify(afterResultDrop)).not.toContain("call-3");
      expect(JSON.stringify(afterResultDrop)).toContain("recent question");
    }).pipe(Effect.scoped, Effect.provide(ThreadStorageMemory)),
  );

  it("the wire guard elides orphans a pre-fix compaction persisted", () => {
    // a surface a pre-pair-balancing engine wrote: the log note is
    // followed by a tool result whose call was shadowed
    const rows = [
      user("Observation log …"),
      toolResult("call-orphan"),
      assistantCall("call-4"),
      toolResult("call-4"),
      user("keep going"),
    ];
    const elided = elideOrphanToolResults(rows);
    expectPairBalanced(elided);
    expect(JSON.stringify(elided)).not.toContain("call-orphan");
    expect(JSON.stringify(elided)).toContain("call-4");
    // a balanced surface passes through untouched (same reference)
    expect(elideOrphanToolResults(elided)).toBe(elided);
  });
});
