import * as AWS from "@/AWS";
import * as Test from "@/Test/Vitest";
import * as resourcegroups from "@distilled.cloud/aws/resource-groups";
import { describe } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

const { test } = Test.make({ providers: AWS.providers() });

const OUT = "/tmp/rg-probe.json";
const results: Record<string, unknown> = {};
const record = (key: string, value: unknown) =>
  Effect.sync(() => {
    results[key] = value;
    require("node:fs").writeFileSync(OUT, JSON.stringify(results, null, 2));
  });

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
        yield* record(
          "variantA",
          Result.isSuccess(a) ? { ok: a.success } : { err: a.failure },
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
          yield* record(
            "groupResources",
            Result.isSuccess(gr) ? { ok: gr.success } : { err: gr.failure },
          );
        }
        yield* cleanup("alchemy-rg-probe-app");

        // Variant B: account settings read (sanity + status of lifecycle events).
        const settings = yield* Effect.result(
          resourcegroups.getAccountSettings({}),
        );
        yield* record(
          "accountSettings",
          Result.isSuccess(settings)
            ? { ok: settings.success }
            : { err: settings.failure },
        );
      }),
    { timeout: 60_000 },
  );
});
