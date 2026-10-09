import * as SDK from "@distilled.cloud/openrouter";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as OpenRouter from "@/OpenRouter";
import * as Test from "@/Test/Alchemy";

const { test } = Test.make({ providers: OpenRouter.providers() });

const hasAnyKey = !!(process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_MANAGEMENT_KEY);

// Ungated probe: OpenRouter's model catalog is public, so the provider's
// credentials path must resolve (anonymously when nothing is configured) and
// reach the API without any key.
test.provider(
  "public listModels works through the provider credentials path",
  () =>
    Effect.gen(function* () {
      const models = yield* SDK.listModels({});
      expect(models.data.length).toBeGreaterThan(0);
      expect(models.data.some((model) => model.id.includes("/"))).toBe(true);
    }),
  { tags: ["provider:openrouter", "live"], timeout: 60_000 },
);

// Ungated probe: a management op with no key fails with the SDK's typed
// `InvalidApiKey` (401), never an untyped catch-all.
test.provider(
  "management op without a key fails with InvalidApiKey",
  () =>
    Effect.gen(function* () {
      const error = yield* SDK.listKeys({}).pipe(
        Effect.provide(OpenRouter.credentials({})),
        SDK.Retry.none,
        Effect.flip,
      );
      expect(error._tag).toBe("InvalidApiKey");
    }),
  { tags: ["provider:openrouter", "live"], timeout: 60_000 },
);

// Same, through the provider's own credentials path — only meaningful when no
// OpenRouter key is configured in the environment.
test.provider.skipIf(hasAnyKey)(
  "unconfigured provider credentials fall back to anonymous",
  () =>
    Effect.gen(function* () {
      const error = yield* SDK.listGuardrails({}).pipe(SDK.Retry.none, Effect.flip);
      expect(error._tag).toBe("InvalidApiKey");
    }),
  { tags: ["provider:openrouter", "live"], timeout: 60_000 },
);
