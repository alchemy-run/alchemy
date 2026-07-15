import * as AWS from "@/AWS";
import * as Test from "@/Test/Vitest";
import * as devopsguru from "@distilled.cloud/aws/devops-guru";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

const { test } = Test.make({ providers: AWS.providers() });

const probe = (name: string, eff: Effect.Effect<unknown, unknown>) =>
  Effect.gen(function* () {
    const result = yield* Effect.result(eff);
    if (Result.isSuccess(result)) {
      console.log(`${name}: OK`, JSON.stringify(result.success).slice(0, 150));
    } else {
      console.log(
        `${name}: FAIL`,
        JSON.stringify(result.failure).slice(0, 500),
      );
    }
  });

test.provider("probe devops-guru data plane ops", () =>
  Effect.gen(function* () {
    yield* probe("describeAccountHealth", devopsguru.describeAccountHealth({}));
    yield* probe(
      "describeAccountOverview",
      devopsguru.describeAccountOverview({
        FromTime: new Date(Date.now() - 24 * 3600_000),
      }),
    );
    yield* probe(
      "listInsights",
      devopsguru.listInsights({
        StatusFilter: { Ongoing: { Type: "REACTIVE" } },
      }),
    );
    yield* probe(
      "searchInsights",
      devopsguru.searchInsights({
        Type: "REACTIVE",
        StartTimeRange: { FromTime: new Date(Date.now() - 24 * 3600_000) },
      }),
    );
    yield* probe(
      "describeResourceCollectionHealth",
      devopsguru.describeResourceCollectionHealth({
        ResourceCollectionType: "AWS_CLOUD_FORMATION",
      }),
    );
    yield* probe(
      "listMonitoredResources",
      devopsguru.listMonitoredResources({}),
    );
  }),
);
