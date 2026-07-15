import * as AWS from "@/AWS";
import * as Test from "@/Test/Vitest";
import * as resourcegroups from "@distilled.cloud/aws/resource-groups";
import { describe } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

const { test } = Test.make({ providers: AWS.providers() });

const cleanup = (name: string) =>
  resourcegroups
    .deleteGroup({ Group: name })
    .pipe(Effect.catch(() => Effect.void));

describe("RG probe", () => {
  test.provider(
    "probe application-group creation + groupResources",
    (_stack) =>
      Effect.gen(function* () {
        yield* cleanup("alchemy-rg-probe-app");
        // Variant A: single ApplicationGroup configuration item.
        const a = yield* Effect.result(
          resourcegroups.createGroup({
            Name: "alchemy-rg-probe-app",
            Configuration: [
              {
                Type: "AWS::ResourceGroups::ApplicationGroup",
                Parameters: [
                  { Name: "Name", Values: ["alchemy-rg-probe-app"] },
                ],
              },
            ],
          }),
        );
        yield* Effect.log(
          `variant A: ${Result.isSuccess(a) ? "OK" : JSON.stringify(a.failure, null, 2)}`,
        );

        if (Result.isSuccess(a)) {
          const gr = yield* Effect.result(
            resourcegroups.groupResources({
              Group: "alchemy-rg-probe-app",
              ResourceArns: [
                "arn:aws:lambda:us-east-1:000000000000:function:does-not-exist",
              ],
            }),
          );
          yield* Effect.log(
            `groupResources: ${Result.isSuccess(gr) ? JSON.stringify(gr.success) : JSON.stringify(gr.failure, null, 2)}`,
          );
        }
        yield* cleanup("alchemy-rg-probe-app");

        // Variant B: account settings read (sanity + status of lifecycle events).
        const settings = yield* Effect.result(
          resourcegroups.getAccountSettings({}),
        );
        yield* Effect.log(
          `accountSettings: ${Result.isSuccess(settings) ? JSON.stringify(settings.success) : JSON.stringify(settings.failure)}`,
        );
      }),
    { timeout: 60_000 },
  );
});
