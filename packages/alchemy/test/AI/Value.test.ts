/**
 * Dynamic prose within a static upper bound (reassess §F):
 * `${AI.value(Tag)}` interpolates a service-resolved string into an
 * otherwise static charter. The tag joins Req (a declared dependency,
 * provided by a Layer); resolution happens once at interpretation.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as LanguageModel from "effect/unstable/ai/LanguageModel";
import type * as Response from "effect/unstable/ai/Response";
import * as AI from "@/AI/index.ts";
import { RuntimeContext } from "@/RuntimeContext.ts";

// a service whose (string) value is spliced into the charter
class RepoState extends Context.Service<RepoState, string>()(
  "test/RepoState",
) {}

class Reviewer extends AI.Agent<Reviewer>()("Reviewer")`
You review PRs. Current repo state: ${AI.value(RepoState)}.` {}

const usage = {
  inputTokens: {
    uncached: undefined,
    total: 1,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

describe("AI.value — dynamic prose", () => {
  it("renders a {hole} without context (topology/preview)", () => {
    const prose = AI.renderTemplate(
      (Reviewer as any).template,
      (Reviewer as any).refs,
    );
    expect(prose).toContain("Current repo state: {test/RepoState}");
  });

  it.effect("the kernel fills the value from context at interpretation", () =>
    Effect.gen(function* () {
      let systemSeen = "";
      const model = Layer.effect(
        LanguageModel.LanguageModel,
        LanguageModel.make({
          generateText: () => Effect.die(new Error("streamText only")),
          streamText: (options) => {
            systemSeen = options.prompt.content
              .flatMap((m) =>
                typeof m.content === "string"
                  ? [m.content]
                  : m.content.map((p: any) => ("text" in p ? p.text : "")),
              )
              .join("\n");
            return Stream.fromIterable([
              { type: "text-start", id: "t" } as never,
              { type: "text-delta", id: "t", delta: "ok" } as never,
              { type: "text-end", id: "t" } as never,
              {
                type: "finish",
                reason: "stop",
                usage,
                response: undefined,
              } as never,
            ] as Array<Response.StreamPartEncoded>);
          },
        }),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const kernel = yield* AI.Kernel;
          const reviewer = yield* kernel.interpret(Reviewer);
          yield* reviewer.dispatch("review PR #3");
        }),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            AI.memory.pipe(Layer.provide(model)),
            Layer.succeed(RepoState, "3 open PRs, main is green"),
            RuntimeContext.phantom,
          ),
        ),
      );

      // the DYNAMIC value reached the model's system prompt
      expect(systemSeen).toContain("3 open PRs, main is green");
      expect(systemSeen).not.toContain("{test/RepoState}");
    }),
  );
});
