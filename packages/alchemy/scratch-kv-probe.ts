import { Endpoint } from "@distilled.cloud/aws";
import { fromChain } from "@distilled.cloud/aws/Credentials";
import { Region } from "@distilled.cloud/aws/Region";
import * as kv from "@distilled.cloud/aws/kinesis-video";
import * as kvam from "@distilled.cloud/aws/kinesis-video-archived-media";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";

const StreamName = "alchemy-probe-listfragments";

const main = Effect.gen(function* () {
  const existing = yield* kv.describeStream({ StreamName }).pipe(
    Effect.map((r) => r.StreamInfo),
    Effect.catchTag("ResourceNotFoundException", () =>
      Effect.succeed(undefined),
    ),
  );
  if (existing === undefined) {
    yield* kv.createStream({
      StreamName,
      MediaType: "video/h264",
      DataRetentionInHours: 24,
    });
  }
  const info = yield* kv.describeStream({ StreamName }).pipe(
    Effect.map((r) => r.StreamInfo),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (i): boolean => i?.Status === "ACTIVE",
      times: 20,
    }),
  );
  const arn = info!.StreamARN!;
  console.log("stream", arn, info!.Status);

  const ep = yield* kv.getDataEndpoint({
    StreamARN: arn,
    APIName: "LIST_FRAGMENTS",
  });
  console.log("endpoint", ep.DataEndpoint);

  const result = yield* Effect.result(
    kvam
      .listFragments({ StreamARN: arn })
      .pipe(
        Effect.provideService(
          Endpoint.Endpoint,
          Effect.succeed(ep.DataEndpoint!),
        ),
      ),
  );
  if (Result.isSuccess(result)) {
    console.log("SUCCESS fragments:", result.success.Fragments?.length ?? 0);
  } else {
    console.log(
      "FAILURE:",
      JSON.stringify(result.failure, null, 2).slice(0, 1200),
    );
  }

  yield* kv
    .deleteStream({ StreamARN: arn })
    .pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.void));
  console.log("deleted");
}).pipe(
  Effect.provideService(Region, Effect.succeed("us-east-1")),
  Effect.provide(fromChain()),
);

await Effect.runPromise(main as Effect.Effect<void, unknown, never>).catch(
  (e) => {
    console.log("DEFECT:", String(e).slice(0, 1200));
  },
);
