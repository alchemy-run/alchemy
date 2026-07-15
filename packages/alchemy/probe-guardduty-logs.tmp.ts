import * as cwlogs from "@distilled.cloud/aws/cloudwatch-logs";
import * as guardduty from "@distilled.cloud/aws/guardduty";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { DefaultAWSLayer } from "./src/AWS/AWS.ts";

const main = Effect.gen(function* () {
  // 1. Current detector state
  const detectors = yield* Effect.result(guardduty.listDetectors({}));
  if (Result.isSuccess(detectors)) {
    console.log("detectors:", detectors.success.DetectorIds);
    for (const id of detectors.success.DetectorIds ?? []) {
      const d = yield* Effect.result(guardduty.getDetector({ DetectorId: id }));
      if (Result.isSuccess(d)) {
        console.log(id, "status:", d.success.Status, "tags:", d.success.Tags);
      } else {
        console.log(id, "getDetector FAILED:", d.failure);
      }
    }
  } else {
    console.log("listDetectors FAILED:", detectors.failure);
  }

  // 2. Fixture Lambda logs
  const groups = yield* Effect.result(
    cwlogs.describeLogGroups({ logGroupNamePrefix: "/aws/lambda/" }),
  );
  if (Result.isSuccess(groups)) {
    const gd = (groups.success.logGroups ?? []).filter((g) =>
      g.logGroupName?.toLowerCase().includes("guardduty"),
    );
    console.log(
      "guardduty log groups:",
      gd.map((g) => g.logGroupName),
    );
    for (const g of gd) {
      const events = yield* Effect.result(
        cwlogs.filterLogEvents({
          logGroupName: g.logGroupName!,
          startTime: Date.now() - 120 * 60 * 1000,
          filterPattern: "?ERROR ?Error ?_tag ?cause",
          limit: 20,
        }),
      );
      if (Result.isSuccess(events)) {
        for (const e of events.success.events ?? []) {
          console.log("---", new Date(e.timestamp!).toISOString());
          console.log((e.message ?? "").slice(0, 2000));
        }
      } else {
        console.log("filterLogEvents FAILED:", events.failure);
      }
    }
  } else {
    console.log("describeLogGroups FAILED:", groups.failure);
  }
}).pipe(Effect.provide(DefaultAWSLayer));

await Effect.runPromise(main as any);
