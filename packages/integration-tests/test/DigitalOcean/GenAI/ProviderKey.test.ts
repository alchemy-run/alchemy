import * as DigitalOcean from "@alchemy.run/digitalocean";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { getGenaiModelRouter } from "@distilled.cloud/digitalocean";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { isGone, logLevel } from "../support.ts";

const { test } = Test.make({ providers: DigitalOcean.providers() });

const LIVE_TAGS = ["provider:digitalocean", "provider:digitalocean:genai", "live"];

// DigitalOcean checks a provider key with the provider when it is added, so
// the lifecycle needs a real OpenAI or Anthropic key; this pins the typed
// rejection of one that is not.
test.provider(
  "a provider key the provider rejects fails with InvalidProviderKey",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const error = yield* stack
        .deploy(
          DigitalOcean.GenAI.ProviderKey("Anthropic", {
            provider: "anthropic",
            apiKey: Redacted.make("sk-ant-not-a-real-key"),
          }),
        )
        .pipe(Effect.flip);
      expect(String(error)).toContain("InvalidProviderKey");
      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: LIVE_TAGS },
);

test.provider(
  "model router: create, update in place, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const created = yield* stack.deploy(
        DigitalOcean.GenAI.ModelRouter("Router", {
          description: "first",
          fallbackModels: ["mistral-3-14B"],
        }),
      );
      const updated = yield* stack.deploy(
        DigitalOcean.GenAI.ModelRouter("Router", {
          description: "second",
          fallbackModels: ["mistral-3-14B"],
        }),
      );
      expect(updated.modelRouterId).toEqual(created.modelRouterId);
      const router = yield* getGenaiModelRouter({ uuid: created.modelRouterId });
      expect(router.model_router.description).toEqual("second");

      yield* stack.destroy();
      expect(yield* isGone(getGenaiModelRouter({ uuid: created.modelRouterId }))).toBe(true);
    }).pipe(logLevel),
  { tags: LIVE_TAGS },
);
