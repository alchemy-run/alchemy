import * as AWS from "@/AWS";
import * as Test from "@/Test/Vitest";
import * as route53 from "@distilled.cloud/aws/route-53";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

const { test } = Test.make({ providers: AWS.providers() });

const ZONE = "Z0833455LR0AKLIWHZFZ";

test.provider(
  "purge and delete the leaked zone, report every step",
  () =>
    Effect.gen(function* () {
      const sets = yield* route53
        .listResourceRecordSets({ HostedZoneId: ZONE, MaxItems: 100 })
        .pipe(
          Effect.map((r) => r.ResourceRecordSets ?? []),
          Effect.catchTag("NoSuchHostedZone", () => Effect.succeed([])),
        );
      const setSummary = sets.map((s) => `${s.Type}:${s.Name}`);
      const deletable = sets.filter((s) => s.Type !== "SOA" && s.Type !== "NS");
      let changeResult = "skipped";
      if (deletable.length > 0) {
        const r = yield* route53
          .changeResourceRecordSets({
            HostedZoneId: ZONE,
            ChangeBatch: {
              Changes: deletable.map((set) => ({
                Action: "DELETE" as const,
                ResourceRecordSet: set,
              })),
            },
          })
          .pipe(Effect.result);
        changeResult = Result.isSuccess(r)
          ? "deleted-records"
          : `change-failed:${(r.failure as { _tag?: string })._tag}`;
      }
      const del = yield* route53
        .deleteHostedZone({ Id: ZONE })
        .pipe(Effect.result);
      const delResult = Result.isSuccess(del)
        ? "deleted"
        : `delete-failed:${(del.failure as { _tag?: string })._tag}:${String(
            (del.failure as { message?: string }).message ?? "",
          ).slice(0, 120)}`;
      expect(JSON.stringify({ setSummary, changeResult, delResult })).toBe(
        "__show__",
      );
    }),
  { timeout: 60_000 },
);
