/**
 * The SAME driver, a REAL model: swap the scripted LanguageModel for
 * Anthropic and nothing else changes — that is the whole point of the
 * layered driver. One smoke test, gated on `ANTHROPIC_API_KEY` (run
 * via `doppler run -p alchemy-v2 -c dev -- bun run test …`).
 */
import { DriverMemory } from "@/AI/DriverMemory.ts";
import { RuntimeContext } from "@/RuntimeContext.ts";
import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic";
import { describe, expect, it } from "alchemy-test";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {
  Researcher,
  ResearcherCharter,
  Search,
} from "./fixtures/researcher.ts";

const Anthropic = AnthropicLanguageModel.layer({
  model: "claude-haiku-4-5",
}).pipe(
  Layer.provide(
    AnthropicClient.layerConfig({
      apiKey: Config.redacted("ANTHROPIC_API_KEY").pipe(
        Config.option,
        Config.map((o) => (o._tag === "Some" ? o.value : undefined)),
      ),
    }),
  ),
  Layer.provide(FetchHttpClient.layer),
);

describe("DriverMemory ⨯ Anthropic", () => {
  it.live.skipIf(!process.env.ANTHROPIC_API_KEY)(
    "runs the real loop: dispatch → tool → answer",
    () => {
      const corpus: string[] = [];
      const search = Layer.succeed(Search, ((input: { query: string }) =>
        Effect.sync(() => {
          corpus.push(input.query);
          return `Fact: the alchemy-effect framework calls its model "Infrastructure-as-Effects" (IaE).`;
        })) as never);
      return Effect.gen(function* () {
        // the user-facing spelling: the agent's default Layer was
        // provided below; its tag resolves to the actor verbs
        const researcher = yield* Researcher;
        const answer = (yield* researcher.dispatch(
          "Use the search tool to find out what the alchemy-effect framework calls its model, then answer with that name. You MUST search first.",
        )) as string;

        // the model actually used the tool…
        expect(corpus.length).toBeGreaterThan(0);
        // …and grounded its answer in the result
        expect(answer).toContain("Infrastructure-as-Effects");
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Researcher.make(ResearcherCharter).pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                DriverMemory.pipe(Layer.provide(Anthropic)),
                search,
                RuntimeContext.phantom,
              ),
            ),
          ),
        ),
      );
    },
    { timeout: 60_000 },
  );
});
