/**
 * The minimal in-memory agent loop, driven entirely by a SCRIPTED
 * LanguageModel (no network) and one tiny org (Researcher + Search).
 *
 * What the loop must do (the consensus of pi / codex / opencode /
 * vercel-ai, built on effect AI's single-shot `generateText`):
 *
 * - `dispatch` admits one work item and resolves at the run's next
 *   QUIESCENCE (the model stops calling tools);
 * - the charter renders as the system prompt; spliced tools compile
 *   into the model's toolkit; tool handlers resolve from Layers;
 * - tool calls loop: results append to the conversation and the model
 *   is called again until it stops;
 * - `steer` splices at the SAMPLING BOUNDARY: delivered mid-run, it
 *   becomes a user message BEFORE the next model call, never aborting
 *   the in-flight step;
 * - a quiesced run PARKS: `steer` wakes it for another round;
 * - `settle` ends a run from the outside, idempotently — a settled
 *   run ignores further input.
 */
import * as AI from "@/AI/index.ts";
import { KernelMemory } from "@/AI/KernelMemory.ts";
import { RuntimeContext } from "@/RuntimeContext.ts";
import { describe, expect, it } from "alchemy-test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import {
  Archives,
  Researcher,
  Scholar,
  Search,
} from "./fixtures/researcher.ts";
import * as Model from "./fixtures/ScriptedModel.ts";
import { Engineer, Lead } from "./fixtures/team.ts";

/** Search physics that records every invocation. */
const recordingSearch = () => {
  const queries: string[] = [];
  const layer = Layer.succeed(Search, ((input: { query: string }) =>
    Effect.sync(() => {
      queries.push(input.query);
      return `results for ${input.query}: alchemy is IaE`;
    })) as never);
  return { queries, layer };
};

const testLayer = (
  model: Model.ScriptedModel,
  capabilities: Layer.Layer<any, any, any>,
) =>
  Layer.mergeAll(
    KernelMemory.pipe(Layer.provide(model.layer)),
    capabilities,
    RuntimeContext.phantom,
  );

describe("KernelMemory", () => {
  it.effect("dispatch admits one item and resolves at quiescence", () => {
    const model = Model.make([
      () => [
        Model.text("Alchemy is Infrastructure-as-Effects."),
        Model.finish(),
      ],
    ]);
    const search = recordingSearch();
    return Effect.gen(function* () {
      const researcher = yield* AI.interpret(Researcher);
      const answer = yield* researcher.dispatch("What is alchemy?");
      expect(answer).toBe("Alchemy is Infrastructure-as-Effects.");

      // the charter rendered as the system prompt…
      const call = model.calls[0]!;
      const prompt = Model.promptText(call);
      expect(prompt).toContain("careful researcher");
      // …the work item arrived as a user message…
      expect(prompt).toContain("What is alchemy?");
      // …and the spliced tool was offered to the model, compiled from
      // its own prose and parameter splices (spawn is intrinsic)
      expect(call.tools.map((tool) => tool.name)).toEqual(["search", "spawn"]);
    }).pipe(Effect.scoped, Effect.provide(testLayer(model, search.layer)));
  });

  it.effect("tool calls loop until the model stops", () => {
    const model = Model.make([
      // round 1: the model wants the tool
      () => [
        Model.toolCall("search", { query: "alchemy" }),
        Model.finish("tool-calls"),
      ],
      // round 2: it saw the result and answers
      () => [Model.text("It is IaE."), Model.finish()],
    ]);
    const search = recordingSearch();
    return Effect.gen(function* () {
      const researcher = yield* AI.interpret(Researcher);
      const answer = yield* researcher.dispatch("What is alchemy?");
      expect(answer).toBe("It is IaE.");

      // the handler ran with the model's typed params
      expect(search.queries).toEqual(["alchemy"]);
      // and the SECOND model call saw the tool result in-conversation
      expect(model.calls).toHaveLength(2);
      expect(Model.promptText(model.calls[1]!)).toContain(
        "results for alchemy",
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer(model, search.layer)));
  });

  it.effect("steer splices at the sampling boundary, mid-run", () => {
    const model = Model.make([
      () => [
        Model.toolCall("search", { query: "sources" }),
        Model.finish("tool-calls"),
      ],
      () => [Model.text("Done, with primary sources."), Model.finish()],
    ]);
    return Effect.gen(function* () {
      // tool physics we can HOLD OPEN: the run is provably mid-step
      // when the steer arrives
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const search = Layer.succeed(Search, ((_: { query: string }) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(started, void 0);
          yield* Deferred.await(release);
          return "raw results";
        })) as never);

      const answer = yield* Effect.gen(function* () {
        const researcher = yield* AI.interpret(Researcher);
        const fiber = yield* Effect.forkChild(
          researcher.dispatch("Research alchemy"),
        );
        // the model called the tool and is blocked inside it
        yield* Deferred.await(started);
        // steer NOW — mid-step; must not abort the in-flight tool
        yield* researcher.steer("Prefer primary sources.");
        yield* Deferred.succeed(release, void 0);
        return yield* Fiber.join(fiber);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            KernelMemory.pipe(Layer.provide(model.layer)),
            search,
            RuntimeContext.phantom,
          ),
        ),
      );

      expect(answer).toBe("Done, with primary sources.");
      // the steer arrived BEFORE the second sampling, as a user message
      expect(model.calls).toHaveLength(2);
      expect(Model.promptText(model.calls[1]!)).toContain(
        "Prefer primary sources.",
      );
      // and the first call never saw it
      expect(Model.promptText(model.calls[0]!)).not.toContain(
        "Prefer primary sources.",
      );
    }).pipe(Effect.scoped);
  });

  it.live("a parked run wakes on steer and dies on settle", () => {
    const model = Model.make([
      () => [Model.text("noted"), Model.finish()],
      () => [Model.text("updated"), Model.finish()],
    ]);
    const search = recordingSearch();
    const calls = (count: number) =>
      Effect.sync(() => model.calls.length).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("10 millis"),
          until: (length) => length >= count,
          times: 200,
        }),
      );
    return Effect.gen(function* () {
      const researcher = yield* AI.interpret(Researcher);

      // keyed admission — the run is addressable by world identity
      const first = yield* researcher.dispatch("issue opened", {
        key: "repo#7",
      });
      expect(first).toBe("noted");

      // quiesced ⇒ parked; steer wakes it for another round
      yield* researcher.steer("repo#7", "the author replied");
      yield* calls(2);
      expect(Model.promptText(model.calls[1]!)).toContain("the author replied");

      // the world closes the work: settle ends the run
      yield* researcher.settle("repo#7", { closed: true });
      // …and a settled run ignores further input (no third call)
      yield* researcher.steer("repo#7", "anyone home?");
      yield* Effect.sleep("100 millis");
      expect(model.calls).toHaveLength(2);

      // dispatch on a settled key resolves immediately with the outcome
      const late = yield* researcher.dispatch("hello?", { key: "repo#7" });
      expect(late).toEqual({ closed: true });

      // settle is idempotent — a second settle is a no-op
      yield* researcher.settle("repo#7", { closed: "again" });
    }).pipe(Effect.scoped, Effect.provide(testLayer(model, search.layer)));
  });

  it.effect("agent references compile into ONE dispatch tool", () => {
    const model = Model.make([
      // call 0: the LEAD delegates
      () => [
        Model.toolCall("dispatch", {
          agent: "Engineer",
          task: "patch the parser",
        }),
        Model.finish("tool-calls"),
      ],
      // call 1: the ENGINEER's own run answers
      () => [Model.text("patched the parser"), Model.finish()],
      // call 2: the lead reports
      () => [Model.text("Engineer patched the parser."), Model.finish()],
    ]);
    const kernel = KernelMemory.pipe(Layer.provide(model.layer));
    return Effect.gen(function* () {
      const lead = yield* AI.interpret(Lead);
      const answer = yield* lead.dispatch("The parser is broken");
      expect(answer).toBe("Engineer patched the parser.");
      expect(model.calls).toHaveLength(3);

      // ONE dispatch tool, not one tool per agent; its description
      // names the closed set of delegates the charter hired
      const tools = model.calls[0]!.tools;
      expect(tools.map((tool) => tool.name)).toEqual(["dispatch", "spawn"]);
      expect(tools[0]!.description).toContain("Engineer");

      // the engineer's call is its OWN conversation: its charter, the
      // handed task, and nothing of the lead's transcript
      const engineerPrompt = Model.promptText(model.calls[1]!);
      expect(engineerPrompt).toContain("exactly the task you are handed");
      expect(engineerPrompt).toContain("patch the parser");
      expect(engineerPrompt).not.toContain("The parser is broken");
      expect(engineerPrompt).not.toContain("You run engineering");

      // the delegate's answer came back to the lead as a tool result
      expect(Model.promptText(model.calls[2]!)).toContain("patched the parser");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          kernel,
          // the Engineer is an ordinary Layer — the kernel-default
          // implementation over the same kernel
          AI.layer(Engineer).pipe(Layer.provide(kernel)),
          RuntimeContext.phantom,
        ),
      ),
    );
  });

  it.effect("spawn conjures an anonymous worker with a tool subset", () => {
    const model = Model.make([
      // call 0: the researcher spawns a fact-checker
      () => [
        Model.toolCall("spawn", {
          instructions: "You are a meticulous fact checker.",
          task: "Verify the claim about alchemy.",
          tools: ["search"],
        }),
        Model.finish("tool-calls"),
      ],
      // call 1: the WORKER uses its granted tool
      () => [
        Model.toolCall("search", { query: "alchemy claim" }),
        Model.finish("tool-calls"),
      ],
      // call 2: the worker answers
      () => [Model.text("verified"), Model.finish()],
      // call 3: the spawner concludes
      () => [Model.text("The claim is verified."), Model.finish()],
    ]);
    const search = recordingSearch();
    return Effect.gen(function* () {
      const researcher = yield* AI.interpret(Researcher);
      const answer = yield* researcher.dispatch("Check the claim");
      expect(answer).toBe("The claim is verified.");
      expect(model.calls).toHaveLength(4);

      // the worker's conversation: the WRITTEN role as its system
      // prompt (not the spawner's charter), the task, and ONLY the
      // granted subset — no spawn, no dispatch (workers are leaves)
      const worker = model.calls[1]!;
      const workerPrompt = Model.promptText(worker);
      expect(workerPrompt).toContain("meticulous fact checker");
      expect(workerPrompt).toContain("Verify the claim");
      expect(workerPrompt).not.toContain("careful researcher");
      expect(worker.tools.map((tool) => tool.name)).toEqual(["search"]);

      // the granted tool really executed in the worker's run
      expect(search.queries).toEqual(["alchemy claim"]);

      // the worker's answer returned to the spawner as a tool result
      expect(Model.promptText(model.calls[3]!)).toContain("verified");
    }).pipe(Effect.scoped, Effect.provide(testLayer(model, search.layer)));
  });

  it.effect(
    "skills are dormant until activated, and retire on deactivate",
    () => {
      const model = Model.make([
        // call 0: no skill tools yet — the model activates Archives
        () => [
          Model.toolCall("skill", { action: "activate", skill: "Archives" }),
          Model.finish("tool-calls"),
        ],
        // call 1: the skill's tools are live — use one
        () => [
          Model.toolCall("search", { query: "fall of Rome" }),
          Model.finish("tool-calls"),
        ],
        // call 2: done with the archives — deactivate
        () => [
          Model.toolCall("skill", { action: "deactivate", skill: "Archives" }),
          Model.finish("tool-calls"),
        ],
        // call 3: answer (skill tools gone again)
        () => [Model.text("Rome fell in 476."), Model.finish()],
      ]);
      const search = recordingSearch();
      return Effect.gen(function* () {
        const scholar = yield* AI.interpret(Scholar);
        const answer = yield* scholar.dispatch("When did Rome fall?");
        expect(answer).toBe("Rome fell in 476.");
        expect(model.calls).toHaveLength(4);

        const names = (index: number) =>
          model.calls[index]!.tools.map((tool) => tool.name);

        // DORMANT: access granted, tools absent — only the intrinsics
        expect(names(0)).toEqual(["spawn", "skill"]);
        // activation returned the skill's PROSE as the tool result…
        expect(Model.promptText(model.calls[1]!)).toContain(
          "one fact per query",
        );
        // …and enabled its tools for the run
        expect(names(1)).toEqual(["search", "spawn", "skill"]);
        expect(search.queries).toEqual(["fall of Rome"]);
        // deactivation retires them
        expect(names(3)).toEqual(["spawn", "skill"]);
      }).pipe(
        Effect.scoped,
        // the charter requires the SKILL's tag; the skill's Layer is
        // what pulls in the tool physics — nominal and encapsulated
        Effect.provide(
          testLayer(
            model,
            AI.layer(Archives).pipe(Layer.provide(search.layer)),
          ),
        ),
      );
    },
  );

  it.effect("spawn hands skills over pre-activated", () => {
    const model = Model.make([
      // call 0: the scholar spawns an archivist WITH the skill
      () => [
        Model.toolCall("spawn", {
          instructions: "You are an archivist.",
          task: "Find the date Rome fell.",
          skills: ["Archives"],
        }),
        Model.finish("tool-calls"),
      ],
      // call 1: the WORKER — skill prose in its system, tool live
      () => [
        Model.toolCall("search", { query: "Rome 476" }),
        Model.finish("tool-calls"),
      ],
      // call 2: the worker answers
      () => [Model.text("476 AD"), Model.finish()],
      // call 3: the scholar concludes
      () => [Model.text("Rome fell in 476 AD."), Model.finish()],
    ]);
    const search = recordingSearch();
    return Effect.gen(function* () {
      const scholar = yield* AI.interpret(Scholar);
      const answer = yield* scholar.dispatch("When did Rome fall?");
      expect(answer).toBe("Rome fell in 476 AD.");
      expect(model.calls).toHaveLength(4);

      // the worker got the skill ACTIVATED: prose in its system
      // prompt, the skill's tool in its (fixed) toolkit — and no
      // intrinsics of its own (workers are leaves)
      const worker = model.calls[1]!;
      expect(Model.promptText(worker)).toContain("You are an archivist.");
      expect(Model.promptText(worker)).toContain("one fact per query");
      expect(worker.tools.map((tool) => tool.name)).toEqual(["search"]);
      expect(search.queries).toEqual(["Rome 476"]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        testLayer(model, AI.layer(Archives).pipe(Layer.provide(search.layer))),
      ),
    );
  });

  it.effect(
    "distinct keys are distinct runs with separate conversations",
    () => {
      const model = Model.make([
        (options) => [
          // echo which conversation the model saw
          Model.text(
            Model.promptText(options).includes("first issue") ? "one" : "two",
          ),
          Model.finish(),
        ],
      ]);
      const search = recordingSearch();
      return Effect.gen(function* () {
        const researcher = yield* AI.interpret(Researcher);
        const [one, two] = yield* Effect.all([
          researcher.dispatch("first issue", { key: "repo#1" }),
          researcher.dispatch("second issue", { key: "repo#2" }),
        ]);
        expect(one).toBe("one");
        expect(two).toBe("two");
        // neither conversation leaked into the other
        expect(Model.promptText(model.calls[0]!)).not.toContain("second issue");
        expect(Model.promptText(model.calls[1]!)).not.toContain("first issue");
      }).pipe(Effect.scoped, Effect.provide(testLayer(model, search.layer)));
    },
  );
});
