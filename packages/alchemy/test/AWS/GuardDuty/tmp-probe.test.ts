import * as AWS from "@/AWS";
import * as Test from "@/Test/Vitest";
import * as cwlogs from "@distilled.cloud/aws/cloudwatch-logs";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as HttpClient from "effect/unstable/http/HttpClient";

const { test } = Test.make({ providers: AWS.providers() });

test.provider(
  "probe: fixture lambda error logs (exact prefix)",
  (_stack) =>
    Effect.gen(function* () {
      // Trigger a fresh failure so logs are hot.
      const client = yield* HttpClient.HttpClient;
      yield* Effect.result(
        client
          .get(
            "https://o5dbkkvelrsgdgmarletex4lue0dwgkl.lambda-url.us-west-2.on.aws/members",
          )
          .pipe(Effect.flatMap((r) => r.text)),
      );
      yield* Effect.sleep("5 seconds");

      const groups = yield* Effect.result(
        cwlogs.describeLogGroups({
          logGroupNamePrefix: "/aws/lambda/GuardDutyBindings",
        }),
      );
      if (!Result.isSuccess(groups)) {
        console.log("describeLogGroups FAILED:", String(groups.failure));
        return;
      }
      console.log(
        "groups:",
        (groups.success.logGroups ?? []).map((g) => g.logGroupName),
      );
      for (const g of groups.success.logGroups ?? []) {
        const events = yield* Effect.result(
          cwlogs.filterLogEvents({
            logGroupName: g.logGroupName!,
            startTime: Date.now() - 30 * 60 * 1000,
            filterPattern: "?ERROR ?errorType ?FiberFailure ?_tag",
            limit: 10,
          }),
        );
        if (Result.isSuccess(events)) {
          for (const e of events.success.events ?? []) {
            console.log("---", new Date(e.timestamp!).toISOString());
            console.log((e.message ?? "").slice(0, 4000));
          }
        } else {
          console.log("filterLogEvents FAILED:", String(events.failure));
        }
      }
    }),
  { timeout: 90_000 },
);
