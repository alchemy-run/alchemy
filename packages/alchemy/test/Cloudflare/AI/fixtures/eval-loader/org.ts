/**
 * The org + scripted model the worker-loader fixtures share: ONE agent
 * granting two tools (a value-returning `search` and a `readFile` that
 * fails with a declared tagged error), and a LanguageModel whose single
 * move is to call `eval` with the program the TEST supplies.
 *
 * Both fixture workers ({@link ../worker.ts} over `CodeModeAsync` +
 * `EvalWorkerLoader`, and `effect-worker.ts` over `CodeModeEffect` +
 * `EvalWorkerLoaderEffect`) run the SAME session through
 * {@link sessionFacts}, so a difference in the reported facts is a
 * difference in the convention/evaluator — nothing else.
 */
import * as AI from "@/AI/index.ts";
import { DriverLocal } from "@/AI/DriverLocal.ts";
import { ThreadStorageMemory } from "@/AI/ThreadStorageMemory.ts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as S from "effect/Schema";
import * as Stream from "effect/Stream";
import * as LanguageModel from "effect/unstable/ai/LanguageModel";
import type * as Response from "effect/unstable/ai/Response";

// ─── the org under test ─────────────────────────────────────────────

const query = AI.Parameter("query", S.String)`The search query.`;

export class Search extends (AI.Tool<Search>()("search")`
Search the corpus for ${query}.`) {}

export class Missing extends Data.TaggedError("Missing")<{ path: string }> {}

const path = AI.Parameter("path", S.String)`Path to read.`;

export class ReadFile extends (AI.Tool<ReadFile>()("readFile")`
Read ${path}; fails with ${Missing} when the file is absent.`) {}

export class Probe extends AI.Agent<Probe>()("Probe") {}

export const ProbeCharter = AI.fragment`
You verify the isolate evaluator. Use ${Search} and ${ReadFile}.`;

// ─── a minimal scripted LanguageModel (owned by THIS suite) ─────────

const finish = (reason: "stop" | "tool-calls"): Response.PartEncoded =>
  ({
    type: "finish",
    reason,
    response: undefined,
    usage: {
      inputTokens: {
        uncached: undefined,
        total: undefined,
        cacheRead: undefined,
        cacheWrite: undefined,
      },
      outputTokens: { total: undefined, text: undefined, reasoning: undefined },
    },
  }) as unknown as Response.PartEncoded;

/** Call 1: run `code` through the eval tool. Call 2+: stop with "done". */
export const scriptedModel = (code: string) => {
  const calls: Array<LanguageModel.ProviderOptions> = [];
  const step = (
    options: LanguageModel.ProviderOptions,
  ): ReadonlyArray<Response.PartEncoded> => {
    calls.push(options);
    return calls.length === 1
      ? [
          {
            type: "tool-call",
            id: "call-eval",
            name: "eval",
            params: { code },
          } as Response.PartEncoded,
          finish("tool-calls"),
        ]
      : [
          { type: "text", text: "done" } as Response.PartEncoded,
          finish("stop"),
        ];
  };
  const layer = Layer.effect(
    LanguageModel.LanguageModel,
    LanguageModel.make({
      generateText: (options) => Effect.sync(() => [...step(options)]),
      streamText: (options) =>
        Stream.fromIterable(step(options)).pipe(
          Stream.flatMap(
            (part): Stream.Stream<Response.StreamPartEncoded> =>
              part.type === "text"
                ? (Stream.make(
                    { type: "text-start", id: "t" },
                    { type: "text-delta", id: "t", delta: part.text },
                    { type: "text-end", id: "t" },
                  ) as unknown as Stream.Stream<Response.StreamPartEncoded>)
                : Stream.make(part as Response.StreamPartEncoded),
          ),
        ),
    }),
  );
  return { layer, calls };
};

/** What a fixture route reports back — the observable facts of one session. */
export interface SessionFacts {
  readonly answer: string;
  readonly wireTools: ReadonlyArray<string>;
  readonly signature: string;
  readonly resultPrompt: string;
  readonly queries: ReadonlyArray<string>;
}

/**
 * Run ONE complete session (real driver, real charter, real codemode)
 * over the given already-provided {@link AI.Tools}, and report the
 * facts: the answer, the tool names the model was offered, the
 * generated signature, what the second model call saw (the tool
 * result), and which tool invocations actually executed.
 */
export const sessionFacts = (options: {
  readonly code: string;
  readonly codeMode: Layer.Layer<AI.Tools>;
}) =>
  Effect.gen(function* () {
    const model = scriptedModel(options.code);
    const queries: string[] = [];
    const searchLayer = Layer.succeed(Search, ((input: { query: string }) =>
      Effect.sync(() => {
        queries.push(input.query);
        return `results for ${input.query}`;
      })) as never);
    const readFileLayer = Layer.succeed(ReadFile, ((input: { path: string }) =>
      Effect.fail(new Missing({ path: input.path }))) as never);

    const stack = Layer.mergeAll(
      DriverLocal.pipe(
        Layer.provide(ThreadStorageMemory),
        Layer.provide(model.layer),
      ),
      options.codeMode,
      searchLayer,
      readFileLayer,
    );

    return yield* Effect.gen(function* () {
      const driver = yield* AI.Driver;
      const probe = yield* driver.interpret(Probe, ProbeCharter);
      const answer = yield* probe.dispatch("go");
      return {
        answer: String(answer),
        wireTools: model.calls[0]?.tools.map((tool) => tool.name) ?? [],
        signature: model.calls[0]?.tools[0]?.description ?? "",
        resultPrompt: JSON.stringify(model.calls[1]?.prompt.content ?? ""),
        queries,
      } satisfies SessionFacts;
    }).pipe(Effect.scoped, Effect.provide(stack), Effect.orDie);
  });
