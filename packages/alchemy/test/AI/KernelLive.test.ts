/**
 * The memory kernel against a REAL model (Anthropic, `claude-haiku-4-5`)
 * — the smallest live slice: one agent, one tool, one dispatch. Proves
 * the interpretation pipeline end to end outside of scripts: the
 * rendered charter steers the model, the advertised schema round-trips
 * through Anthropic's tool-use API, the kernel executes the tool
 * (`disableToolCallResolution`), and the kernel-default halt fires.
 *
 * Gated on `ANTHROPIC_API_KEY` — skips cleanly when unset:
 *
 *   ANTHROPIC_API_KEY=sk-… bun vitest run test/AI/KernelLive.test.ts
 */
import * as AnthropicClient from "@effect/ai-anthropic/AnthropicClient";
import * as AnthropicLanguageModel from "@effect/ai-anthropic/AnthropicLanguageModel";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as S from "effect/Schema";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as AI from "@/AI/index.ts";
import { RuntimeContext } from "@/RuntimeContext.ts";

const apiKey = process.env.ANTHROPIC_API_KEY;

// ─── the org: one agent, one tool ────────────────────────────────

const a = AI.Parameter("a", S.Number)`the left operand`;
const b = AI.Parameter("b", S.Number)`the right operand`;

class Multiply extends AI.Tool<Multiply>()("multiply")`
Multiply ${a} by ${b} and return the product. Arithmetic in your head
is forbidden — always use this tool.` {}

class Mathematician extends AI.Agent<Mathematician>()("Mathematician")`
You are a careful mathematician. You never do arithmetic yourself:
use ${Multiply} for every multiplication, then state the result as
plain digits (no thousands separators).` {}

// ─── physics ─────────────────────────────────────────────────────

const invocations: Array<{ a: number; b: number }> = [];

const MultiplyLive = Layer.succeed(Multiply, ((input: {
  a: number;
  b: number;
}) =>
  Effect.sync(() => {
    invocations.push(input);
    return { product: input.a * input.b };
  })) as never);

const ModelLive = AnthropicLanguageModel.layer({
  model: "claude-haiku-4-5",
}).pipe(
  Layer.provide(
    AnthropicClient.layer({
      apiKey: apiKey === undefined ? undefined : Redacted.make(apiKey),
    }),
  ),
  Layer.provide(FetchHttpClient.layer),
);

const KernelLive = Layer.mergeAll(
  AI.memory.pipe(Layer.provide(ModelLive)),
  MultiplyLive,
  RuntimeContext.phantom,
);

// ─── the test ────────────────────────────────────────────────────

describe("memory kernel × live Anthropic", () => {
  it.effect.skipIf(apiKey === undefined)(
    "one agent, one tool, one dispatch",
    () =>
      Effect.gen(function* () {
        const outcome = yield* Effect.scoped(
          Effect.gen(function* () {
            const kernel = yield* AI.Kernel;
            const mathematician = yield* kernel.interpret(Mathematician);
            return (yield* mathematician.dispatch(
              "What is 1234 multiplied by 5678?",
            )) as AI.Step.HaltOutcome;
          }),
        ).pipe(Effect.provide(KernelLive));

        // the model used OUR tool (executed by the kernel, not effect/ai)
        expect(invocations).toEqual([{ a: 1234, b: 5678 }]);
        // the kernel-default halt fired and the answer came back
        expect(outcome._tag).toBe("Completed");
        if (outcome._tag === "Completed") {
          expect(outcome.text).toContain("7006652");
        }
      }),
    { timeout: 60_000 },
  );
});
