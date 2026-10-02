import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as cognitiveservices from "@distilled.cloud/azure/cognitiveservices";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
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

// Subscription-scoped, no other resources: $0, seconds. The testing
// subscription answers the PUT (api-version 2026-07-15-preview) with
// HTTP 405 and an empty body, so the preview feature is not enabled for
// it; run with AZURE_TEST_PAID=1 on a subscription that has it.
test.provider.skipIf(!runPaidOnly)(
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
