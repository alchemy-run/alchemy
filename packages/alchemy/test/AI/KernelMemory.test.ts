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
import * as Ref from "effect/Ref";
import * as S from "effect/Schema";
import * as Schedule from "effect/Schedule";
import {
  ArchivesLive,
  DeepArchives,
  DeepArchivesLive,
  PaleographyLive,
  Researcher,
  ResearcherCharter,
  Scholar,
  ScholarCharter,
  Search,
} from "./fixtures/researcher.ts";
import * as Model from "./fixtures/ScriptedModel.ts";
import {
  Engineer,
  EngineerCharter,
  Lead,
  LeadCharter,
} from "./fixtures/team.ts";

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
  capabilities: Layer.Layer<never, any, any>,
) =>
  Layer.mergeAll(
    KernelMemory.pipe(Layer.provide(model.layer)),
    capabilities,
    RuntimeContext.phantom,
  );

/**
 * These tests exercise the KERNEL CONTRACT directly —
 * `Kernel.interpret(term, charter)` — the primitive that
 * `Agent.make(charter)` packages as a Layer. Application code never
 * calls this; it resolves the agent's tag.
 */
const interpret = (term: AI.Interpretable, charter: AI.Charter) =>
  Effect.orDie(
    Effect.flatMap(AI.Kernel, (kernel) => kernel.interpret(term, charter)),
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
      const researcher = yield* interpret(Researcher, ResearcherCharter);
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
      const researcher = yield* interpret(Researcher, ResearcherCharter);
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
        const researcher = yield* interpret(Researcher, ResearcherCharter);
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
      const researcher = yield* interpret(Researcher, ResearcherCharter);

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
      const lead = yield* interpret(Lead, LeadCharter);
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
          Engineer.make(EngineerCharter).pipe(Layer.provide(kernel)),
          RuntimeContext.phantom,
        ),
      ),
    );
  });

  it.live(
    "parallel fan-out: two dispatches in one sampling run concurrently",
    () => {
      const model = Model.make([
        // call 0: the lead fans out TWO sessions in ONE sampling —
        // the kernel executes the handlers concurrently
        () => [
          Model.toolCall(
            "dispatch",
            { agent: "Engineer", task: "build widget A", session: "a" },
            "call-a",
          ),
          Model.toolCall(
            "dispatch",
            { agent: "Engineer", task: "build widget B", session: "b" },
            "call-b",
          ),
          Model.finish("tool-calls"),
        ],
        // calls 1..2: the two engineer runs (concurrent — order unknown,
        // so ONE step answers by reading its own task from the prompt;
        // calls beyond the script replay the last step)
        (options) => [
          Model.text(
            Model.promptText(options).includes("widget A")
              ? "A built"
              : "B built",
          ),
          Model.finish(),
        ],
        // call 3: the lead concludes — REPLAYED step must handle it too
      ]);
      const seen: Array<AI.KernelObservation> = [];
      const ObserverLive = Layer.succeed(AI.KernelObserver, {
        emit: (observation) => Effect.sync(() => void seen.push(observation)),
      });
      const kernel = KernelMemory.pipe(Layer.provide(model.layer));
      return Effect.gen(function* () {
        const lead = yield* interpret(Lead, LeadCharter);
        // the lead's final sampling is the replayed engineer step — its
        // text quiesces the lead, resolving the dispatch
        const answer = yield* lead.dispatch("Two widgets please", {
          key: "job#2",
        });
        expect(typeof answer).toBe("string");
        expect(model.calls).toHaveLength(4);

        // both workers were admitted under deterministic session keys
        for (const childKey of ["job#2/Engineer/a", "job#2/Engineer/b"]) {
          expect(
            seen.filter(
              (observation) =>
                observation.key === childKey && observation.type === "admitted",
            ),
          ).toHaveLength(1);
        }
        // both answers returned to the LEAD's conversation as tool results
        const leadFinal = Model.promptText(model.calls[3]!);
        expect(leadFinal).toContain("A built");
        expect(leadFinal).toContain("B built");
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            kernel,
            Engineer.make(EngineerCharter).pipe(
              Layer.provide(kernel),
              Layer.provide(ObserverLive),
            ),
            ObserverLive,
            RuntimeContext.phantom,
          ),
        ),
      );
    },
  );

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
      const researcher = yield* interpret(Researcher, ResearcherCharter);
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
        const scholar = yield* interpret(Scholar, ScholarCharter);
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
          testLayer(model, ArchivesLive.pipe(Layer.provide(search.layer))),
        ),
      );
    },
  );

  it.effect(
    "the skill graph: activating a parent exposes its referenced skills",
    () => {
      const model = Model.make([
        // call 0: only the parent is visible — activate it
        () => [
          Model.toolCall("skill", {
            action: "activate",
            skill: "DeepArchives",
          }),
          Model.finish("tool-calls"),
        ],
        // call 1: the child surfaced in the teaching — descend
        () => [
          Model.toolCall("skill", {
            action: "activate",
            skill: "Paleography",
          }),
          Model.finish("tool-calls"),
        ],
        // call 2: both teachings in hand — answer
        () => [
          Model.text("Tenth century, by the letterforms."),
          Model.finish(),
        ],
      ]);
      const search = recordingSearch();
      return Effect.gen(function* () {
        const scholar = yield* interpret(
          Scholar,
          AI.prose`
            You date manuscripts. The stacks are ${DeepArchives}.`,
        );
        const answer = yield* scholar.dispatch("Date this manuscript.");
        expect(answer).toBe("Tenth century, by the letterforms.");
        expect(model.calls).toHaveLength(3);

        const skillTool = (index: number) =>
          model.calls[index]!.tools.find((tool) => tool.name === "skill")!;
        // depth-2 skills stay HIDDEN until their parent activates —
        // the intrinsic's available list is the reachable set
        expect(skillTool(0).description).toContain("DeepArchives");
        expect(skillTool(0).description).not.toContain("Paleography");
        expect(skillTool(1).description).toContain("Paleography");
        // each activation returned its teaching as the tool result
        expect(Model.promptText(model.calls[1]!)).toContain(
          "call numbers first",
        );
        expect(Model.promptText(model.calls[2]!)).toContain("letterforms");
      }).pipe(
        Effect.scoped,
        Effect.provide(
          testLayer(
            model,
            Layer.mergeAll(DeepArchivesLive, PaleographyLive).pipe(
              Layer.provide(search.layer),
            ),
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
      const scholar = yield* interpret(Scholar, ScholarCharter);
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
        testLayer(model, ArchivesLive.pipe(Layer.provide(search.layer))),
      ),
    );
  });

  it.live(
    "a dynamic charter re-renders per tick: an inline tool flips the stance",
    () => {
      const model = Model.make([
        // tick 1: read-only stance — the model enters the sandbox
        () => [Model.toolCall("enter_sandbox", {}), Model.finish("tool-calls")],
        // tick 2: the SYSTEM PROMPT is the flipped stance — answer
        () => [Model.text("done, sandboxed"), Model.finish()],
        // tick 3 (steered awake): stance unchanged — answer again
        () => [Model.text("still sandboxed"), Model.finish()],
      ]);
      const calls = (count: number) =>
        Effect.sync(() => model.calls.length).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("10 millis"),
            until: (length) => length >= count,
            times: 200,
          }),
        );
      return Effect.gen(function* () {
        const charter = Effect.gen(function* () {
          // INIT — once per run: plain Ref state + an inline tool closing over it
          const sandboxed = yield* Ref.make(false);
          const enter = yield* AI.Tool("enter_sandbox")`
Enter the sandbox.`(() =>
            Ref.set(sandboxed, true).pipe(Effect.as("you are now sandboxed")),
          );
          // TURN — before every sampling: the stance follows the state
          return Effect.gen(function* () {
            return yield* (yield* Ref.get(sandboxed))
              ? AI.prose`You are IN the sandbox; nothing you run is real.`
              : AI.prose`You are read-only until you ${enter}.`;
          });
        });
        const researcher = yield* interpret(Researcher, charter);
        const answer = yield* researcher.dispatch("try the sandbox");
        expect(answer).toBe("done, sandboxed");

        // tick 1: the render IS the system prompt; the inline tool
        // (closure over the local) was offered
        const first = Model.promptText(model.calls[0]!);
        expect(first).toContain("read-only until");
        expect(model.calls[0]!.tools.map((tool) => tool.name)).toEqual([
          "enter_sandbox",
          "spawn",
        ]);

        // tick 2: the flipped render REPLACED the system prompt —
        // no diffing, no derived messages — and the tool retired
        const second = Model.promptText(model.calls[1]!);
        expect(second).toContain("You are IN the sandbox");
        expect(second).not.toContain("read-only until");
        expect(second).not.toContain("<situation>");
        expect(model.calls[1]!.tools.map((tool) => tool.name)).toEqual([
          "spawn",
        ]);

        // tick 3: the parked run steered awake — the stance is
        // unchanged, so the system prompt is byte-identical (once)
        yield* researcher.steer("still there?");
        yield* calls(3);
        const third = Model.promptText(model.calls[2]!);
        expect(third.match(/nothing you run is real/g)).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(testLayer(model, Layer.empty)));
    },
  );

  it.effect(
    "effect splices render at every tick: the run's key in prose",
    () => {
      const model = Model.make([() => [Model.text("ack"), Model.finish()]]);
      return Effect.gen(function* () {
        // a STATIC charter whose splice is still dynamic — an effect
        // reading AI.Thread, evaluated at render time with the run provided
        const charter = AI.prose`
You are working ${Effect.map(AI.Thread, (thread) => thread.key)}. Answer briefly.`;
        const researcher = yield* interpret(Researcher, charter);
        yield* researcher.dispatch("hello", { key: "repo#9" });
        expect(Model.promptText(model.calls[0]!)).toContain(
          "You are working repo#9.",
        );
      }).pipe(Effect.scoped, Effect.provide(testLayer(model, Layer.empty)));
    },
  );

  it.effect("a non-Fragment turn result ANSWERS the round and parks", () => {
    const model = Model.make([
      // tick 1: the model marks the work done via the inline tool
      () => [
        Model.toolCall("mark_done", { result: 42 }),
        Model.finish("tool-calls"),
      ],
      // (tick 2 never samples — the turn answers first)
    ]);
    return Effect.gen(function* () {
      const charter = Effect.gen(function* () {
        const result = AI.Parameter("result", S.Number)`The final result.`;
        const done = yield* Ref.make<number | undefined>(undefined);
        const markDone = yield* AI.Tool("mark_done")`
Record the final ${result}.`((p) =>
          Ref.set(done, p.result).pipe(Effect.as("recorded")),
        );
        return Effect.gen(function* () {
          const value = yield* Ref.get(done);
          if (value !== undefined) return { answer: value }; // ← reply
          return yield* AI.prose`Compute the answer, then ${markDone}.`;
        });
      });
      const researcher = yield* interpret(Researcher, charter);
      // dispatch resolves with the TYPED answer, not the model's text
      const outcome = yield* researcher.dispatch("go", { key: "job#1" });
      expect(outcome).toEqual({ answer: 42 });
      expect(model.calls).toHaveLength(1); // the answer tick never sampled
      // ANSWER ≠ SETTLE: the run PARKED — a follow-up dispatch wakes
      // the same run (context intact); this charter's turn re-answers
      // from its standing Ref without sampling
      const late = yield* researcher.dispatch("again?", { key: "job#1" });
      expect(late).toEqual({ answer: 42 });
      expect(model.calls).toHaveLength(1);
      // ending remains the owner's act
      yield* researcher.settle("job#1", { closed: true });
      const settled = yield* researcher.dispatch("hello?", { key: "job#1" });
      expect(settled).toEqual({ closed: true });
    }).pipe(Effect.scoped, Effect.provide(testLayer(model, Layer.empty)));
  });

  it.live("dispatch sessions resume the same worker; settle cascades", () => {
    const model = Model.make([
      // call 0: the lead hires the engineer in session "fix"
      () => [
        Model.toolCall("dispatch", {
          agent: "Engineer",
          task: "build the widget",
          session: "fix",
        }),
        Model.finish("tool-calls"),
      ],
      // call 1: the engineer's round 1
      () => [Model.text("built it"), Model.finish()],
      // call 2: the lead follows up IN THE SAME SESSION
      () => [
        Model.toolCall("dispatch", {
          agent: "Engineer",
          task: "now polish it",
          session: "fix",
        }),
        Model.finish("tool-calls"),
      ],
      // call 3: the engineer's round 2 — the SAME conversation
      () => [Model.text("polished"), Model.finish()],
      // call 4: the lead concludes
      () => [Model.text("All done."), Model.finish()],
    ]);
    const seen: Array<AI.KernelObservation> = [];
    const ObserverLive = Layer.succeed(AI.KernelObserver, {
      emit: (observation) => Effect.sync(() => void seen.push(observation)),
    });
    const kernel = KernelMemory.pipe(Layer.provide(model.layer));
    return Effect.gen(function* () {
      const lead = yield* interpret(Lead, LeadCharter);
      const answer = yield* lead.dispatch("Widget needed", { key: "job#1" });
      expect(answer).toBe("All done.");
      expect(model.calls).toHaveLength(5);

      // round 2 continued round 1's conversation — the worker kept
      // its context across the call/reply boundary
      const round2 = Model.promptText(model.calls[3]!);
      expect(round2).toContain("build the widget");
      expect(round2).toContain("built it");
      expect(round2).toContain("now polish it");

      // the session key is DETERMINISTIC, namespaced under the lead's
      // run — and both dispatches hit ONE run (one admission)
      const childKey = "job#1/Engineer/fix";
      expect(
        seen.filter(
          (observation) =>
            observation.key === childKey && observation.type === "admitted",
        ),
      ).toHaveLength(1);

      // SUPERVISION: settling the lead settles its session worker
      yield* lead.settle("job#1", { done: true });
      yield* Effect.sync(() =>
        seen.some(
          (observation) =>
            observation.key === childKey && observation.type === "settled",
        ),
      ).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("10 millis"),
          until: (cascaded) => cascaded,
          times: 200,
        }),
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          kernel,
          Engineer.make(EngineerCharter).pipe(
            Layer.provide(kernel),
            Layer.provide(ObserverLive),
          ),
          ObserverLive,
          RuntimeContext.phantom,
        ),
      ),
    );
  });

  it.effect(
    "charter init runs per run: distinct keys get distinct state",
    () => {
      const model = Model.make([
        () => [Model.toolCall("bump", {}), Model.finish("tool-calls")],
        () => [Model.text("done"), Model.finish()],
        () => [Model.text("done"), Model.finish()],
      ]);
      return Effect.gen(function* () {
        let inits = 0;
        const initKeys: string[] = [];
        const charter = Effect.gen(function* () {
          inits++;
          // init is per-run: the thread EXISTS at admit, so
          // thread-scoped setup may read its identity here
          const { key } = yield* AI.Thread;
          initKeys.push(key);
          const count = yield* Ref.make(0);
          const bump = yield* AI.Tool("bump")`Increment the counter.`(() =>
            Ref.update(count, (n) => n + 1).pipe(Effect.as("bumped")),
          );
          return Effect.gen(function* () {
            return yield* AI.prose`
Counter: ${Ref.get(count)}. Use ${bump} when told.`;
          });
        });
        const researcher = yield* interpret(Researcher, charter);
        yield* researcher.dispatch("bump once", { key: "a" }); // bumps a's ref
        yield* researcher.dispatch("just answer", { key: "b" });
        expect(inits).toBe(2); // one instance per run
        expect(initKeys).toEqual(["a", "b"]); // init saw each run's thread
        // run b's SECOND tick would show its own counter still at 0 —
        // check via the prompt each run saw
        expect(Model.promptText(model.calls[1]!)).toContain("Counter: 1"); // a, tick 2
        expect(Model.promptText(model.calls[2]!)).toContain("Counter: 0"); // b, tick 1
      }).pipe(Effect.scoped, Effect.provide(testLayer(model, Layer.empty)));
    },
  );

  it.effect("prose margins are stripped; relative indentation survives", () => {
    const model = Model.make([() => [Model.text("ok"), Model.finish()]]);
    return Effect.gen(function* () {
      const charter = AI.prose`
        You follow the checklist:
          - search first
          - answer second
      `;
      const researcher = yield* interpret(Researcher, charter);
      yield* researcher.dispatch("hi");
      const prompt = Model.promptText(model.calls[0]!);
      expect(prompt).toContain("You follow the checklist:");
      expect(prompt).toContain("\\n  - search first"); // margin gone, nesting kept
    }).pipe(Effect.scoped, Effect.provide(testLayer(model, Layer.empty)));
  });

  it.effect(
    "compaction: a handoff tool resets the thread at the boundary",
    () => {
      const model = Model.make([
        // tick 1: burn some history, then hand off
        () => [
          Model.toolCall("handoff", { summary: "tried A; B is next" }),
          Model.finish("tool-calls"),
        ],
        // tick 2: thread was reset — answer
        () => [Model.text("continuing from summary"), Model.finish()],
      ]);
      return Effect.gen(function* () {
        const charter = Effect.gen(function* () {
          const summary = AI.Parameter("summary", S.String)`
Decisions made, open threads, blockers.`;
          // the run is a RUNTIME fact: the handler yields AI.Thread when
          // it fires — init never sees it
          const handoff = yield* AI.Tool("handoff")`
Summarize progress as ${summary}; your context restarts from it.`((p) =>
            AI.Thread.pipe(
              Effect.flatMap((thread) =>
                thread.compact({ reset: { summary: p.summary } }),
              ),
              Effect.as("compacted"),
            ),
          );
          return Effect.gen(function* () {
            return yield* AI.prose`Work the task. ${handoff} when the thread grows stale.`;
          });
        });
        const researcher = yield* interpret(Researcher, charter);
        const answer = yield* researcher.dispatch("start the work", {
          key: "c#1",
        });
        expect(answer).toBe("continuing from summary");
        const second = Model.promptText(model.calls[1]!);
        // the reset thread carries the summary…
        expect(second).toContain("tried A; B is next");
        // …and no longer carries the original work item or the tool call
        expect(second).not.toContain("start the work");
        expect(second).not.toContain("call-handoff");
      }).pipe(Effect.scoped, Effect.provide(testLayer(model, Layer.empty)));
    },
  );

  it.effect("say is a plain append: the author's guard IS the policy", () => {
    const model = Model.make([
      () => [Model.toolCall("bump", {}), Model.finish("tool-calls")], // tick 1
      () => [Model.toolCall("bump", {}), Model.finish("tool-calls")], // tick 2
      () => [Model.text("done"), Model.finish()], // tick 3
    ]);
    return Effect.gen(function* () {
      const charter = Effect.gen(function* () {
        const bump = yield* AI.Tool("bump")`Keep working.`(() =>
          Effect.succeed("ok"),
        );
        return Effect.gen(function* () {
          const { count } = yield* AI.Tick;
          // UNGUARDED: delivers every tick — no dedupe, no memory
          yield* AI.say`Status check.`;
          // GUARDED: the `===` condition delivers exactly once
          if (count === 1) yield* AI.say`One sampling done — settle in.`;
          return yield* AI.prose`Work the task with ${bump}.`;
        });
      });
      const researcher = yield* interpret(Researcher, charter);
      yield* researcher.dispatch("go", { key: "s#1" });

      // the unguarded say accumulated one note PER TICK
      const third = Model.promptText(model.calls[2]!);
      expect(third.match(/Status check\./g)).toHaveLength(3);
      // the guarded say fired exactly once (count===1, before tick 2)
      expect(Model.promptText(model.calls[0]!)).not.toContain("settle in");
      expect(third.match(/One sampling done — settle in\./g)).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(testLayer(model, Layer.empty)));
  });

  it.effect(
    "a compaction reset restates standing state into the fresh thread",
    () => {
      const model = Model.make([
        // tick 1: enter the parked stance
        () => [Model.toolCall("park", {}), Model.finish("tool-calls")],
        // tick 2: the system prompt now carries the parked stance; hands off
        () => [
          Model.toolCall("handoff", { summary: "asked the author about X" }),
          Model.finish("tool-calls"),
        ],
        // tick 3: fresh thread — must still know it is parked
        () => [Model.text("waiting"), Model.finish()],
      ]);
      return Effect.gen(function* () {
        const charter = Effect.gen(function* () {
          const summary = AI.Parameter(
            "summary",
            S.String,
          )`What happened so far.`;
          const parked = yield* Ref.make(false);
          const park = yield* AI.Tool("park")`Park on the author.`(() =>
            Ref.set(parked, true).pipe(Effect.as("parked")),
          );
          const handoff = yield* AI.Tool("handoff")`
Summarize as ${summary}; the thread restarts.`((p) =>
            AI.Thread.pipe(
              Effect.flatMap((thread) =>
                thread.compact({ reset: { summary: p.summary } }),
              ),
              Effect.as("compacted"),
            ),
          );
          return Effect.gen(function* () {
            return yield* AI.prose`
Triage the issue; ${park} when blocked. ${handoff} to compact.

${
  (yield* Ref.get(parked))
    ? AI.prose`You are parked on the author; judge their next reply.`
    : AI.prose``
}`;
          });
        });
        const researcher = yield* interpret(Researcher, charter);
        yield* researcher.dispatch("start", { key: "r#1" });

        const third = Model.promptText(model.calls[2]!);
        // the fresh thread carries the summary, and the SYSTEM PROMPT
        // still states the parked stance (the render is the prompt)…
        expect(third).toContain("asked the author about X");
        expect(third).toContain("parked on the author");
        // …and none of the pre-reset traffic
        expect(third).not.toContain("call-park");
      }).pipe(Effect.scoped, Effect.provide(testLayer(model, Layer.empty)));
    },
  );

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
        const researcher = yield* interpret(Researcher, ResearcherCharter);
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

  it.effect(
    "the observer seam: run lifecycle facts flow out, seq-ordered",
    () => {
      const model = Model.make([
        () => [
          Model.toolCall("search", { query: "x" }),
          Model.finish("tool-calls"),
        ],
        () => [Model.text("answer"), Model.finish()],
      ]);
      return Effect.gen(function* () {
        const seen: Array<AI.KernelObservation> = [];
        const ObserverLive = Layer.succeed(AI.KernelObserver, {
          emit: (observation) => Effect.sync(() => void seen.push(observation)),
        });
        const search = recordingSearch();
        const researcher = yield* interpret(
          Researcher,
          AI.prose`Search with ${Search}, then answer.`,
        ).pipe(Effect.provide([ObserverLive, search.layer]));
        yield* researcher.dispatch("find x", { key: "o#1" });

        // token slices + live tool calls stream while a sampling is in
        // flight — the canonical record is everything else
        const deltas = seen.filter(
          (observation) => observation.type === "assistant-delta",
        );
        expect(
          deltas.map(
            (delta) => delta.type === "assistant-delta" && delta.delta,
          ),
        ).toEqual(["answer"]); // tick 1's streamed text
        const liveCalls = seen.filter(
          (observation) => observation.type === "tool-call",
        );
        expect(
          liveCalls.map((call) => call.type === "tool-call" && call.toolName),
        ).toEqual(["search"]); // tick 0's call, surfaced live
        // `parked` races the dispatch resolution (the loop emits it
        // right after quiescence) — exclude the live-view facts and
        // the park from the canonical-record assertion
        const record = seen.filter(
          (observation) =>
            observation.type !== "assistant-delta" &&
            observation.type !== "tool-call" &&
            observation.type !== "parked",
        );
        expect(record.map((observation) => observation.type)).toEqual([
          "admitted",
          "input", // the dispatched task
          "assistant", // tick 0: calls search
          "tool-result",
          "assistant", // tick 1: quiesces with the answer
        ]);
        // every observation carries the run identity + a monotonic seq
        expect(seen.every((observation) => observation.key === "o#1")).toBe(
          true,
        );
        expect(
          seen.every(
            (observation, index) =>
              index === 0 || observation.seq > seen[index - 1]!.seq,
          ),
        ).toBe(true);
        const second = record[2]!;
        if (second.type === "assistant") {
          expect(second.toolCalls[0]!.name).toBe("search");
        }
        const result = record[3]!;
        if (result.type === "tool-result") {
          expect(result.toolName).toBe("search");
          expect(result.isFailure).toBe(false);
        }
      }).pipe(Effect.scoped, Effect.provide(testLayer(model, Layer.empty)));
    },
  );

  it.effect("codemode(async): grants collapse into one eval tool", () => {
    const model = Model.make([
      // the model programs against the granted capability
      () => [
        Model.toolCall("eval", {
          code: `
            const first = await tools.search({ query: "alchemy" });
            const second = await tools.search({ query: "effect" });
            return first + " // " + second;`,
        }),
        Model.finish("tool-calls"),
      ],
      () => [Model.text("composed"), Model.finish()],
    ]);
    const search = recordingSearch();
    return Effect.gen(function* () {
      const researcher = yield* interpret(Researcher, ResearcherCharter);
      const answer = yield* researcher.dispatch("What is alchemy?");
      expect(answer).toBe("composed");

      // ONE eval tool on the wire (spawn stays — intrinsics are direct)
      const tools = model.calls[0]!.tools.map((tool) => tool.name);
      expect(tools).toEqual(["eval", "spawn"]);
      // the eval tool's description carries the generated signature
      const evalTool = model.calls[0]!.tools[0]!;
      expect(evalTool.description).toContain(
        "declare function search(input: { query: string }): Promise<unknown>",
      );

      // BOTH calls ran in one round trip, in code
      expect(search.queries).toEqual(["alchemy", "effect"]);
      // and the composed result came back as the tool result
      expect(Model.promptText(model.calls[1]!)).toContain(
        "results for alchemy: alchemy is IaE // results for effect: alchemy is IaE",
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        testLayer(model, Layer.mergeAll(search.layer, AI.CodeModeAsync())),
      ),
    );
  });

  it.effect("codemode(effect): the program stays on the kernel fiber", () => {
    const model = Model.make([
      () => [
        Model.toolCall("eval", {
          code: `
            return Effect.gen(function* () {
              const result = yield* tools.search({ query: "alchemy" });
              return "wrapped:" + result;
            });`,
        }),
        Model.finish("tool-calls"),
      ],
      () => [Model.text("done"), Model.finish()],
    ]);
    const search = recordingSearch();
    return Effect.gen(function* () {
      const researcher = yield* interpret(Researcher, ResearcherCharter);
      yield* researcher.dispatch("go");

      const evalTool = model.calls[0]!.tools[0]!;
      expect(evalTool.description).toContain(
        "declare function search(input: { query: string }): Effect<unknown>",
      );
      expect(search.queries).toEqual(["alchemy"]);
      expect(Model.promptText(model.calls[1]!)).toContain(
        "wrapped:results for alchemy",
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        testLayer(model, Layer.mergeAll(search.layer, AI.CodeModeEffect())),
      ),
    );
  });

  it.effect("codemode: a broken program fails model-visibly", () => {
    const model = Model.make([
      () => [
        Model.toolCall("eval", { code: `return await tools.nope();` }),
        Model.finish("tool-calls"),
      ],
      () => [Model.text("recovered"), Model.finish()],
    ]);
    const search = recordingSearch();
    return Effect.gen(function* () {
      const researcher = yield* interpret(Researcher, ResearcherCharter);
      const answer = yield* researcher.dispatch("go");
      // the loop survived: the failure came back as a tool result
      expect(answer).toBe("recovered");
      expect(Model.promptText(model.calls[1]!)).toContain("program failed");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        testLayer(model, Layer.mergeAll(search.layer, AI.CodeModeAsync())),
      ),
    );
  });
});
