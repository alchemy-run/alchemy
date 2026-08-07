/**
 * The CONTROL-PLANE hooks (kernel-assembly.md §4): `Governor` and
 * `SamplingPolicy` as Context.Services the kernel consults, with
 * shipped defaults equal to the classic behavior. These tests pin the
 * hook CONTRACTS against the in-memory kernel:
 *
 * - absent hooks: every wake proceeds, quiescence parks, samplings
 *   retry per the default policy (covered implicitly by every other
 *   kernel test);
 * - `Governor.onQuiesce` Continue injects work and the run samples
 *   again — pi's `getContinuationMessages`, as a Layer;
 * - `Governor.beforeRound` Refuse answers waiters with the reason and
 *   never samples;
 * - `SamplingPolicy.step` wraps every sampling.
 */
import * as AI from "@/AI/index.ts";
import { KernelMemory } from "@/AI/KernelMemory.ts";
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

const searchStub = Layer.succeed(Search, ((input: { query: string }) =>
  Effect.succeed(`results for ${input.query}`)) as never);

const testLayer = (
  model: Model.ScriptedModel,
  hooks: Layer.Layer<never, any, any>,
) =>
  Layer.mergeAll(
    KernelMemory.pipe(Layer.provide(model.layer)),
    searchStub,
    hooks,
    RuntimeContext.phantom,
  );

const interpret = (term: AI.Interpretable, charter: AI.Charter) =>
  Effect.orDie(
    Effect.flatMap(AI.Kernel, (kernel) => kernel.interpret(term, charter)),
  );

describe("kernel hooks", () => {
  // it.live: the poll below needs the real clock (it.effect's virtual
  // clock never fires a spaced schedule)
  it.live("Governor.onQuiesce Continue injects another round", () => {
    const model = Model.make([
      () => [Model.text("first pass done"), Model.finish()],
      () => [Model.text("continued and finished"), Model.finish()],
    ]);
    let consulted = 0;
    const governor = Layer.succeed(AI.Governor, {
      beforeRound: () => Effect.succeed(AI.Proceed),
      onQuiesce: () =>
        Effect.sync(() =>
          ++consulted === 1
            ? AI.Continue(["the governor says: keep going"])
            : AI.Park,
        ),
    });
    return Effect.gen(function* () {
      const researcher = yield* interpret(Researcher, ResearcherCharter);
      // dispatch resolves at the FIRST quiescence (waiters are the
      // round's, not the governor's continuation)
      const answer = yield* researcher.dispatch("start");
      expect(answer).toBe("first pass done");
      // the continuation sampled again with the injected input
      yield* Effect.sync(() => model.calls.length).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("10 millis"),
          until: (length) => length >= 2,
          times: 200,
        }),
      );
      expect(model.calls.length).toBe(2);
      expect(Model.promptText(model.calls[1]!)).toContain(
        "the governor says: keep going",
      );
      expect(consulted).toBeGreaterThanOrEqual(2);
    }).pipe(Effect.scoped, Effect.provide(testLayer(model, governor)));
  });

  it.effect("Governor.beforeRound Refuse answers without sampling", () => {
    const model = Model.make([
      () => [Model.text("must never run"), Model.finish()],
    ]);
    const governor = Layer.succeed(AI.Governor, {
      beforeRound: (facts) =>
        Effect.succeed(
          facts.inputs.some(
            (input) => typeof input === "string" && input.includes("forbidden"),
          )
            ? AI.Refuse("budget exhausted — refused by policy")
            : AI.Proceed,
        ),
      onQuiesce: () => Effect.succeed(AI.Park),
    });
    return Effect.gen(function* () {
      const researcher = yield* interpret(Researcher, ResearcherCharter);
      const answer = yield* researcher.dispatch("something forbidden");
      expect(answer).toBe("budget exhausted — refused by policy");
      expect(model.calls.length).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(testLayer(model, governor)));
  });

  it.effect("SamplingPolicy.step wraps every sampling", () => {
    const model = Model.make([
      () => [
        Model.toolCall("search", { query: "alchemy" }),
        Model.finish("tool-calls"),
      ],
      () => [Model.text("done"), Model.finish()],
    ]);
    const seen: Array<{ tick: number }> = [];
    const policy = Layer.succeed(AI.SamplingPolicy, {
      step: (facts, sample) =>
        Effect.suspend(() => {
          seen.push({ tick: facts.tick });
          return sample;
        }),
      malformedBudget: 3,
    });
    return Effect.gen(function* () {
      const researcher = yield* interpret(Researcher, ResearcherCharter);
      const answer = yield* researcher.dispatch("look it up");
      expect(answer).toBe("done");
      // one wrap per sampling: the tool round and the closing round
      expect(seen.map(({ tick }) => tick)).toEqual([0, 1]);
    }).pipe(Effect.scoped, Effect.provide(testLayer(model, policy)));
  });
});
