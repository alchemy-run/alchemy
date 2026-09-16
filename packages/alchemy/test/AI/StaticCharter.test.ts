/**
 * THE STATIC CHARTER — `Agent.make` as a synchronous tagged template
 * (the same shape as `Group.make` / `Skill.make`), and `AI.Tool` as a
 * synchronous definition (`ToolDef`): the org's structure — prose,
 * tools, models — is module-scope data, fully known before anything
 * runs.
 *
 * Pinned here:
 * - the template IS the charter: it rides the Layer as static data
 *   (`Teaching`), and the rendered system prompt is byte-stable
 *   across ticks;
 * - a `ToolDef` (synchronous `AI.Tool(name)`…`(init)`) spliced into
 *   the template grants the tool; its INIT runs where the Layer
 *   builds and its handler serves every call;
 * - applying the template result attaches behavior: RPC methods and
 *   the per-tick `turn` HOOK — side effects and `AI.selectModel`
 *   only, never prose;
 * - `AI.selectModel(Model)` routes the sampling to the selected
 *   model's Layer, and the requirement is inferred (the agent's
 *   Layer must be provided the model implementation).
 */
import * as AI from "@/AI/index.ts";
import { DriverLocal } from "@/AI/DriverLocal.ts";
import { ThreadStorageMemory } from "@/AI/ThreadStorageMemory.ts";
import { RuntimeContext } from "@/RuntimeContext.ts";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as S from "effect/Schema";
import * as Model from "./fixtures/ScriptedModel.ts";

const InMemoryDriver = DriverLocal.pipe(Layer.provide(ThreadStorageMemory));

const key = AI.Thing("key", S.String)`The record's key.`;
const value = AI.Thing("value", S.String)`The record's value.`;

/** The system message a scripted call saw. */
const systemOf = (call: { prompt: { content: ReadonlyArray<any> } }) => {
  const first = call.prompt.content[0];
  return first?.role === "system" ? String(first.content) : undefined;
};

describe("static charters", () => {
  it.live(
    "the template IS the charter: Teaching statics on the Layer, byte-stable prompt, ToolDef init once",
    () => {
      let inits = 0;
      let served = 0;
      const lookup = AI.Tool("lookup")`
        Read ${key} from the archive. Answers ${AI.out(value)}.`(
        Effect.gen(function* () {
          yield* Effect.sync(() => inits++);
          const store = new Map([["alchemy", "Infrastructure-as-Effects"]]);
          return Effect.fn(function* (p: { key: string }) {
            served++;
            return { value: store.get(p.key) ?? "unknown" };
          });
        }),
      );
      // the def is pure data, synchronously — no Effect ran
      expect(AI.isToolDef(lookup)).toBe(true);
      expect(inits).toBe(0);

      class Curator extends AI.Agent<Curator>()("Curator") {}
      const CuratorLive = Curator.make`
        You are the ARCHIVE CURATOR. ${lookup} answers from the
        archive; cite what it returns.`;

      // the charter is STATIC DATA on the Layer (Teaching): the
      // template and its refs are walkable without building anything
      expect(Array.isArray(CuratorLive.template)).toBe(true);
      expect(CuratorLive.refs.some((ref) => ref === lookup)).toBe(true);

      const model = Model.make([
        () => [
          Model.toolCall("lookup", { key: "alchemy" }),
          Model.finish("tool-calls"),
        ],
        () => [Model.text("It is Infrastructure-as-Effects."), Model.finish()],
        () => [Model.text("Still Infrastructure-as-Effects."), Model.finish()],
      ]);

      return Effect.gen(function* () {
        const curator = yield* Curator;
        const first = yield* curator.dispatch("What is alchemy?");
        expect(first).toBe("It is Infrastructure-as-Effects.");
        // the handler served the call; the INIT ran once for the
        // whole interpret, not per tick
        expect(served).toBe(1);
        expect(inits).toBe(1);

        // a second round: the rendered system prompt is byte-stable
        yield* curator.at("main").steer("and again?");
        yield* Effect.sleep(50);
        const systems = model.calls.map(systemOf);
        expect(systems.length).toBeGreaterThanOrEqual(2);
        for (const system of systems) {
          expect(system).toBe(systems[0]);
          expect(system).toContain("ARCHIVE CURATOR");
          expect(system).toContain("`lookup`");
        }
      }).pipe(
        Effect.provide(
          CuratorLive.pipe(
            Layer.provide(InMemoryDriver.pipe(Layer.provide(model.layer))),
          ),
        ),
        Effect.provide(RuntimeContext.phantom),
      );
    },
  );

  it.effect(
    "extras attach behavior: RPC methods answer, and the `turn` hook selects the model",
    () => {
      class Fast extends AI.Model<Fast>()("Fast") {}
      // driver default answers one way; the selected model another
      const byDefault = Model.make([
        () => [Model.text("from-default"), Model.finish()],
      ]);
      const fast = Model.make([
        () => [Model.text("from-fast"), Model.finish()],
      ]);

      class Runner extends AI.Agent<
        Runner,
        { describe: (name: string) => Effect.Effect<string> }
      >()("Runner") {}
      const RunnerLive = Runner.make`
        You are the RUNNER. Answer in one word.`({
        turn: Effect.gen(function* () {
          yield* AI.selectModel(Fast);
        }),
        describe: Effect.fn("describe")(function* (name: string) {
          return `runner:${name}`;
        }),
      });
      // Teaching statics survive the application
      expect(Array.isArray(RunnerLive.template)).toBe(true);

      return Effect.gen(function* () {
        const runner = yield* Runner;
        // the hook's selection routed the sampling to Fast's model
        const answer = yield* runner.dispatch("go");
        expect(answer).toBe("from-fast");
        expect(fast.calls.length).toBe(1);
        expect(byDefault.calls.length).toBe(0);
        // the RPC method runs in the session frame
        const described = yield* runner.at("main").describe("r2");
        expect(described).toBe("runner:r2");
      }).pipe(
        Effect.provide(
          RunnerLive.pipe(
            Layer.provide(InMemoryDriver.pipe(Layer.provide(byDefault.layer))),
            Layer.provide(Fast.layer(fast.service)),
          ),
        ),
        Effect.provide(RuntimeContext.phantom),
      );
    },
  );

  it.effect(
    "an extras INIT Effect implements methods only — the charter stays the template",
    () => {
      class Clerk extends AI.Agent<
        Clerk,
        { uptime: () => Effect.Effect<boolean> }
      >()("Clerk") {}
      const ClerkLive = Clerk.make`
        You are the CLERK.`(
        Effect.gen(function* () {
          // init: resolve services for METHODS (none here); the
          // charter text above is already fixed
          const startedAt = Date.now();
          return {
            uptime: Effect.fn("uptime")(function* () {
              return Date.now() - startedAt >= 0;
            }),
          };
        }),
      );
      const model = Model.make([() => [Model.text("noted"), Model.finish()]]);
      return Effect.gen(function* () {
        const clerk = yield* Clerk;
        expect(yield* clerk.dispatch("hello")).toBe("noted");
        expect(yield* clerk.at("main").uptime()).toBe(true);
        expect(systemOf(model.calls[0]!)).toContain("CLERK");
      }).pipe(
        Effect.provide(
          ClerkLive.pipe(
            Layer.provide(InMemoryDriver.pipe(Layer.provide(model.layer))),
          ),
        ),
        Effect.provide(RuntimeContext.phantom),
      );
    },
  );
});
