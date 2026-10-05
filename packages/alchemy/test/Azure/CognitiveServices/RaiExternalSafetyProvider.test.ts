import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as cognitiveservices from "@distilled.cloud/azure/cognitiveservices";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: { name: string; url: string }) =>
  Effect.gen(function* () {
    const provider = yield* Azure.CognitiveServices.RaiExternalSafetyProvider(
      "Provider",
      {
        name: props.name,
        providerName: "alchemy-safety",
        mode: "sync",
        url: props.url,
      },
    );
    return { provider };
  });

// Subscription-scoped, no other resources: $0, seconds. Not rolled out to the
// pay-as-you-go testing subscription: the RP manifest lists
// `raiExternalSafetyProviders` with no locations, and ARM answers GET with
// 404 and PUT with 405 (both with an empty body) on every advertised
// api-version (2025-10-01-preview through 2026-09-15-preview); no
// Microsoft.CognitiveServices preview feature enables it. Set
// AZURE_TEST_SUBSCRIPTION_RAI=1 on a subscription that has it.
test.provider.skipIf(!process.env.AZURE_TEST_SUBSCRIPTION_RAI)(
  "create, update, replace, and delete an external safety provider",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const subscriptionId = yield* subscription;
      const get = (safetyProviderName: string) =>
        cognitiveservices.GetRaiExternalSafetyProvider({
          subscriptionId,
          safetyProviderName,
        });

      yield* stack.deploy(
        program({ name: "alchemy-esp-a", url: "https://example.com/a" }),
      );
      expect((yield* get("alchemy-esp-a")).properties?.url).toEqual(
        "https://example.com/a",
      );

      yield* stack.deploy(
        program({ name: "alchemy-esp-a", url: "https://example.com/b" }),
      );
      expect((yield* get("alchemy-esp-a")).properties?.url).toEqual(
        "https://example.com/b",
      );

      yield* stack.deploy(
        program({ name: "alchemy-esp-b", url: "https://example.com/b" }),
      );
      expect((yield* get("alchemy-esp-b")).properties?.url).toEqual(
        "https://example.com/b",
      );
      expect(yield* waitGone(get("alchemy-esp-a"))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get("alchemy-esp-b"))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
