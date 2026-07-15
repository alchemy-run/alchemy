import * as AWS from "@/AWS";
import * as Test from "@/Test/Vitest";
import * as macie2 from "@distilled.cloud/aws/macie2";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

const { test } = Test.make({ providers: AWS.providers() });

const probe = (name: string, eff: Effect.Effect<any, any, any>) =>
  Effect.gen(function* () {
    const result = yield* Effect.result(eff);
    if (Result.isSuccess(result)) {
      console.log(
        `PROBE ${name}: OK`,
        JSON.stringify(result.success).slice(0, 250),
      );
    } else {
      const e = result.failure as any;
      console.log(
        `PROBE ${name}: FAIL tag=${e?._tag} message=${String(e?.message).slice(0, 300)}`,
      );
    }
  });

test.provider(
  "probe failing macie2 ops",
  (_stack) =>
    Effect.gen(function* () {
      const pre = yield* Effect.result(macie2.getMacieSession({}));
      if (Result.isSuccess(pre)) {
        console.log("PROBE session already exists — aborting");
        return;
      }
      yield* macie2.enableMacie({ status: "ENABLED" });
      console.log("PROBE macie enabled");
      yield* Effect.sleep("5 seconds");
      yield* probe("getBucketStatistics", macie2.getBucketStatistics({}));
      yield* probe(
        "getAutomatedDiscoveryConfiguration",
        macie2.getAutomatedDiscoveryConfiguration({}),
      );
      yield* probe(
        "listClassificationScopes",
        macie2.listClassificationScopes({}),
      );
      yield* probe("getRevealConfiguration", macie2.getRevealConfiguration({}));
      yield* probe("searchResources", macie2.searchResources({}));
      yield* macie2.disableMacie({});
      console.log("PROBE macie disabled");
    }),
  { timeout: 120_000 },
);
