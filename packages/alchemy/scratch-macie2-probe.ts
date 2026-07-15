/**
 * Probe: enable Macie (only if no session exists), call the four ops that
 * 500'd in the Bindings fixture, print outcome/error tags, disable Macie.
 * Run: cd packages/alchemy && ALCHEMY_PROFILE=testing bun ../../<this file>? — no:
 *   ALCHEMY_PROFILE=testing bun vitest? — no. Plain bun with AWS provider layer.
 */
import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as macie2 from "@distilled.cloud/aws/macie2";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

const testOptions = { providers: AWS.providers() };

const show = <A, E>(label: string, eff: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const r = yield* Effect.result(eff);
    if (Result.isSuccess(r)) {
      console.log(label, "OK", JSON.stringify(r.value).slice(0, 300));
    } else {
      console.log(label, "ERR", JSON.stringify(r.failure).slice(0, 500));
    }
  });

const main = Effect.gen(function* () {
  const pre = yield* Effect.result(macie2.getMacieSession({}));
  if (Result.isSuccess(pre)) {
    console.log("session already exists — aborting probe");
    return;
  }
  yield* macie2.enableMacie({ status: "ENABLED" });
  console.log("macie enabled");
  yield* Effect.sleep("5 seconds");
  yield* show("getBucketStatistics", macie2.getBucketStatistics({}));
  yield* show(
    "getAutomatedDiscoveryConfiguration",
    macie2.getAutomatedDiscoveryConfiguration({}),
  );
  yield* show("listClassificationScopes", macie2.listClassificationScopes({}));
  yield* show("getRevealConfiguration", macie2.getRevealConfiguration({}));
  yield* show("searchResources", macie2.searchResources({}));
  yield* macie2.disableMacie({});
  console.log("macie disabled");
});

Core.withProviders(main, testOptions, "Macie2Probe").pipe(Effect.runPromise);
