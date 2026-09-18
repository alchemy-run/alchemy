/**
 * Compaction as an explicit, introspectable chain (Pillar A):
 *
 * - `thread.compact({ reset })` / `({ drop })` no longer overwrite —
 *   they close a generation and open the next (`advanceGeneration`),
 *   so `lineage` records the chain and `messagesAt` recovers every
 *   shadowed row; a drop that matches nothing advances no generation;
 * - the ambient `AI.Compaction` policy (a Layer on the charter's
 *   context) is consulted at every sampling boundary and rides the
 *   same ledgered mechanism, stamped with the policy's name;
 * - every applied compaction lands a `compaction` observation
 *   carrying the GenerationRecord;
 * - `Sessions.branch(ref, { key })` seeds a new session from any
 *   generation — git's "new ref at a commit" — and refuses to
 *   overwrite an existing key;
 * - the storage ledger behaves identically over memory and sqlite.
 */
import * as AI from "@/AI/index.ts";
import { DriverLocal } from "@/AI/DriverLocal.ts";
import { ThreadStorage } from "@/AI/ThreadStorage.ts";
import { ThreadStorageMemory } from "@/AI/ThreadStorageMemory.ts";
import { ThreadStorageSqlite } from "@/SQLite/ThreadStorageSqlite.ts";
import { RuntimeContext } from "@/RuntimeContext.ts";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
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

describe("compaction generations", () => {
  it.effect(
    "explicit reset closes a generation and keeps it addressable",
    () => {
      const model = Model.make([
        // round: the model asks for the tool (which requests the reset)…
        () => [
          Model.toolCall("search", { query: "compact" }),
          Model.finish("tool-calls"),
        ],
        // …and the next sampling runs over the reset thread
        () => [Model.text("done after reset"), Model.finish()],
      ]);
      const search = compactingSearch({
        reset: { summary: "SUMMARY OF PRIOR WORK" },
      });
      return Effect.gen(function* () {
        const researcher = yield* interpret(Researcher, ResearcherCharter);
        const answer = yield* researcher.dispatch("What is alchemy?", {
          key: "reset-case",
        });
        expect(answer).toBe("done after reset");

        const storage = yield* ThreadStorage;
        const handle = yield* storage.open("Researcher", "reset-case");
        const lineage = yield* handle.lineage;
        expect(lineage.length).toBe(1);
        const record = lineage[0]!;
        expect(record.kind).toBe("reset");
        expect(record.author).toBe("charter");
        expect(record.doc).toBe("SUMMARY OF PRIOR WORK");
        expect(record.ref).toBe("Researcher/reset-case@1");
        expect(record.parent).toBe("Researcher/reset-case@0");
        expect(record.dropped).toBeGreaterThan(0);
        expect(record.tokensBefore).toBeGreaterThan(0);

        // the time machine: the shadowed generation is fully readable
        const shadowed = yield* handle.messagesAt(0);
        expect(shadowed.length).toBe(record.dropped);
        expect(JSON.stringify(shadowed)).toContain("What is alchemy?");

        // the live thread restarts from the summary note
        const live = yield* handle.messages;
        expect(JSON.stringify(live[0])).toContain(
          "restarts from this summary of prior work",
        );
        expect(JSON.stringify(live[0])).toContain("SUMMARY OF PRIOR WORK");

        // the applied compaction landed as a durable observation
        const log = yield* handle.observations(0);
        const observed = log.find((row) => row.type === "compaction");
        expect(observed).toBeDefined();
        if (observed?.type === "compaction") {
          expect(observed.record.ref).toBe(record.ref);
        }
      }).pipe(Effect.scoped, Effect.provide(testLayer(model, search)));
    },
  );

  it.effect("drop archives the matched rows behind a marker", () => {
    const model = Model.make([
      // round 1: plain answer, seeds the row the drop will match
      () => [Model.text("noted"), Model.finish()],
      // round 2: the tool requests the drop…
      () => [
        Model.toolCall("search", { query: "drop" }),
        Model.finish("tool-calls"),
      ],
      // …and the next sampling answers over the compacted thread
      () => [Model.text("after drop"), Model.finish()],
    ]);
    const search = compactingSearch({
      drop: (entry) => JSON.stringify(entry).includes("DROPME"),
    });
    return Effect.gen(function* () {
      const researcher = yield* interpret(Researcher, ResearcherCharter);
      yield* researcher.dispatch("DROPME context noise", { key: "drop-case" });
      const answer = yield* researcher.dispatch("clean question", {
        key: "drop-case",
      });
      expect(answer).toBe("after drop");

      const storage = yield* ThreadStorage;
      const handle = yield* storage.open("Researcher", "drop-case");
      const lineage = yield* handle.lineage;
      expect(lineage.length).toBe(1);
      const record = lineage[0]!;
      expect(record.kind).toBe("drop");
      expect(record.author).toBe("charter");
      expect(record.doc).toBeUndefined();
      expect(record.dropped).toBe(1);

      // marker first, kept rows after; the dropped row is gone from
      // the surface but readable at the shadowed generation
      const live = yield* handle.messages;
      expect(JSON.stringify(live[0])).toContain(
        "[1 earlier message archived by compaction]",
      );
      expect(JSON.stringify(live)).not.toContain("DROPME");
      expect(JSON.stringify(yield* handle.messagesAt(0))).toContain("DROPME");
    }).pipe(Effect.scoped, Effect.provide(testLayer(model, search)));
  });

  it.effect("a drop matching nothing advances no generation", () => {
    const model = Model.make([
      () => [
        Model.toolCall("search", { query: "noop" }),
        Model.finish("tool-calls"),
      ],
      () => [Model.text("unchanged"), Model.finish()],
    ]);
    const search = compactingSearch({ drop: () => false });
    return Effect.gen(function* () {
      const researcher = yield* interpret(Researcher, ResearcherCharter);
      const answer = yield* researcher.dispatch("keep everything", {
        key: "noop-case",
      });
      expect(answer).toBe("unchanged");

      const storage = yield* ThreadStorage;
      const handle = yield* storage.open("Researcher", "noop-case");
      expect(yield* handle.lineage).toEqual([]);
      const log = yield* handle.observations(0);
      expect(log.find((row) => row.type === "compaction")).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(testLayer(model, search)));
  });

  it.effect(
    "the ambient Compaction.reset policy fires at its threshold",
    () => {
      const longAnswer = `Alchemy is Infrastructure-as-Effects. ${"Detail. ".repeat(50)}`;
      const model = Model.make([
        // round 1: a long answer pushes the thread over the threshold
        () => [Model.text(longAnswer), Model.finish()],
        // the policy's own generateText — the model authors the handoff
        () => [
          Model.text("## Objective\nContinue the research."),
          Model.finish(),
        ],
        // round 2 samples over the reset thread
        () => [Model.text("second answer"), Model.finish()],
      ]);
      return Effect.gen(function* () {
        const researcher = yield* interpret(Researcher, ResearcherCharter);
        yield* researcher.dispatch("first question", { key: "policy-case" });
        const second = yield* researcher.dispatch("second question", {
          key: "policy-case",
        });
        expect(second).toBe("second answer");
        // sampling, summary, sampling — three model calls
        expect(model.calls.length).toBe(3);

        const storage = yield* ThreadStorage;
        const handle = yield* storage.open("Researcher", "policy-case");
        const lineage = yield* handle.lineage;
        expect(lineage.length).toBe(1);
        const record = lineage[0]!;
        expect(record.kind).toBe("reset");
        expect(record.author).toBe("reset");
        expect(record.doc).toContain("## Objective");

        // round 1 is shadowed, the live thread restarts from the handoff
        expect(JSON.stringify(yield* handle.messagesAt(0))).toContain(
          "first question",
        );
        const live = yield* handle.messages;
        expect(JSON.stringify(live[0])).toContain("## Objective");
        expect(JSON.stringify(live)).toContain("second question");
      }).pipe(
        Effect.scoped,
        Effect.provide(
          testLayer(
            model,
            stubSearch,
            AI.Compaction.reset({ at: 40 }) as Layer.Layer<never, any, any>,
          ),
        ),
      );
    },
  );

  it.effect("Sessions.branch seeds a new session from a mid-chain ref", () => {
    const model = Model.make([]);
    return Effect.gen(function* () {
      const storage = yield* ThreadStorage;
      const src = yield* storage.open("Researcher", "branch-src");
      yield* src.appendMessages([user("one"), user("two")]);
      yield* src.advanceGeneration({
        author: "charter",
        kind: "reset",
        doc: "handoff @1",
        dropped: 2,
        tokensBefore: 10,
        tokensAfter: 2,
        surface: [user("summary")],
      });

      const sessions = yield* AI.Sessions;
      // branch from the BIRTH generation — the pre-compaction surface
      const birth = yield* sessions.branch("Researcher/branch-src@0", {
        key: "branch-birth",
      });
      expect(birth).toEqual({
        session: "branch-birth",
        ref: "Researcher/branch-birth@1",
      });
      const birthHandle = yield* storage.open("Researcher", "branch-birth");
      expect(yield* birthHandle.messages).toEqual([user("one"), user("two")]);
      const birthLineage = yield* birthHandle.lineage;
      expect(birthLineage.length).toBe(1);
      expect(birthLineage[0]!.kind).toBe("branch");
      expect(birthLineage[0]!.author).toBe("branch");
      expect(birthLineage[0]!.parent).toBe("Researcher/branch-src@0");
      // generation 0 has no record, so no doc rides the branch birth
      expect(birthLineage[0]!.doc).toBeUndefined();

      // branch from the tip — its record's doc rides along
      const tip = yield* sessions.branch("Researcher/branch-src@1", {
        key: "branch-tip",
      });
      expect(tip.ref).toBe("Researcher/branch-tip@1");
      const tipHandle = yield* storage.open("Researcher", "branch-tip");
      expect(yield* tipHandle.messages).toEqual([user("summary")]);
      expect((yield* tipHandle.lineage)[0]!.doc).toBe("handoff @1");

      // the source is untouched
      expect(yield* src.messages).toEqual([user("summary")]);
      expect((yield* src.lineage).length).toBe(1);

      // a branch never overwrites an existing key
      const occupied = yield* Effect.result(
        sessions.branch("Researcher/branch-src@1", { key: "branch-birth" }),
      );
      expect(Result.isFailure(occupied)).toBe(true);
      if (Result.isFailure(occupied)) {
        expect(occupied.failure._tag).toBe("AI.BranchError");
        expect(occupied.failure.reason).toBe("occupied");
      }

      // a ref that does not parse fails typed
      const invalid = yield* Effect.result(
        sessions.branch("not-a-ref", { key: "x" }),
      );
      expect(Result.isFailure(invalid)).toBe(true);
      if (Result.isFailure(invalid)) {
        expect(invalid.failure.reason).toBe("invalid-ref");
      }

      // a generation the source never reached fails typed
      const unknown = yield* Effect.result(
        sessions.branch("Researcher/branch-src@9", { key: "y" }),
      );
      expect(Result.isFailure(unknown)).toBe(true);
      if (Result.isFailure(unknown)) {
        expect(unknown.failure.reason).toBe("unknown-generation");
      }
    }).pipe(Effect.scoped, Effect.provide(testLayer(model)));
  });
});

/** The storage ledger contract, asserted over both local substrates. */
const ledgerContract = (
  name: string,
  storageLayer: Effect.Effect<Layer.Layer<ThreadStorage>, any, any>,
) =>
  describe(name, () => {
    it.effect("advanceGeneration archives, re-points, and chains", () =>
      Effect.gen(function* () {
        const layer = yield* storageLayer;
        yield* Effect.gen(function* () {
          const storage = yield* ThreadStorage;
          const handle = yield* storage.open("GenAgent", "case-1");
          yield* handle.appendMessages([user("a"), user("b")]);

          const first = yield* handle.advanceGeneration({
            author: "charter",
            kind: "reset",
            doc: "summary one",
            dropped: 2,
            tokensBefore: 8,
            tokensAfter: 2,
            surface: [user("s1")],
          });
          expect(first.ref).toBe("GenAgent/case-1@1");
          expect(first.parent).toBe("GenAgent/case-1@0");
          expect(first.generation).toBe(1);

          yield* handle.appendMessages([user("c")]);
          const second = yield* handle.advanceGeneration({
            author: "drop-policy",
            kind: "drop",
            dropped: 1,
            tokensBefore: 4,
            tokensAfter: 3,
            surface: [user("marker"), user("c")],
          });
          expect(second.ref).toBe("GenAgent/case-1@2");
          expect(second.parent).toBe("GenAgent/case-1@1");

          // tip first
          const lineage = yield* handle.lineage;
          expect(lineage.map((row) => row.generation)).toEqual([2, 1]);
          expect(lineage[1]!.doc).toBe("summary one");
          expect(lineage[0]!.doc).toBeUndefined();

          // the time machine reads every generation
          expect(yield* handle.messagesAt(0)).toEqual([user("a"), user("b")]);
          expect(yield* handle.messagesAt(1)).toEqual([user("s1"), user("c")]);
          expect(yield* handle.messagesAt(2)).toEqual(yield* handle.messages);
          expect(yield* handle.messagesAt(99)).toEqual([]);

          // an explicit parent override (a branch birth) is preserved
          const branchy = yield* storage.open("GenAgent", "case-2");
          const born = yield* branchy.advanceGeneration({
            author: "branch",
            kind: "branch",
            dropped: 0,
            tokensBefore: 1,
            tokensAfter: 1,
            parent: "GenAgent/case-1@1",
            surface: [user("s1")],
          });
          expect(born.parent).toBe("GenAgent/case-1@1");

          // appends continue on the new surface
          yield* handle.appendMessages([user("d")]);
          expect((yield* handle.messages).length).toBe(3);

          // remove clears the ledger and the archive
          yield* storage.remove("GenAgent", "case-1");
          const reopened = yield* storage.open("GenAgent", "case-1");
          expect(yield* reopened.lineage).toEqual([]);
          expect(yield* reopened.messagesAt(0)).toEqual([]);
          expect(yield* reopened.messages).toEqual([]);
        }).pipe(Effect.provide(layer));
      }),
    );
  });

ledgerContract(
  "ThreadStorageMemory ledger",
  Effect.succeed(ThreadStorageMemory),
);

ledgerContract(
  "ThreadStorageSqlite ledger",
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectory({ prefix: "compaction-ledger-" });
    return ThreadStorageSqlite(path.join(dir, "runs.sqlite"));
  }),
);
