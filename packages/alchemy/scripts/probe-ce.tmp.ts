import * as ce from "@distilled.cloud/aws/cost-explorer";
import * as Credentials from "@distilled.cloud/aws/Credentials";
import { Region } from "@distilled.cloud/aws/Region";
import { NodeServices } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

const runtime = Layer.mergeAll(
  NodeServices.layer,
  FetchHttpClient.layer,
  Credentials.fromChain(),
  Layer.succeed(Region, Effect.succeed("us-east-1")),
);

const main = Effect.gen(function* () {
  for (const Granularity of ["HOURLY", "DAILY", "MONTHLY"] as const) {
    for (const ApproximationDimension of ["SERVICE", "RESOURCE"] as const) {
      const approx = yield* Effect.result(
        ce.getApproximateUsageRecords({ Granularity, ApproximationDimension }),
      );
      if (Result.isSuccess(approx)) {
        console.log(
          `approx ${Granularity}/${ApproximationDimension} OK`,
          JSON.stringify(approx.success).slice(0, 200),
        );
      } else {
        console.log(
          `approx ${Granularity}/${ApproximationDimension} ERR`,
          JSON.stringify(approx.failure).slice(0, 200),
        );
      }
    }
  }

  const rightsizing = yield* Effect.result(
    ce.getRightsizingRecommendation({ Service: "AmazonEC2" }),
  );
  if (Result.isSuccess(rightsizing)) {
    console.log(
      "rightsizing OK",
      JSON.stringify(rightsizing.success).slice(0, 300),
    );
  } else {
    console.log(
      "rightsizing ERR",
      JSON.stringify(rightsizing.failure, null, 2).slice(0, 2000),
    );
  }
}).pipe(Effect.provide(runtime));

Effect.runPromise(main).catch((e) => {
  console.error("died:", e);
  process.exit(1);
});
