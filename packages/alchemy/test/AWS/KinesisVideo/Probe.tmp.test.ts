// TEMPORARY debug probe — exercises ListFragments locally via distilled to
// surface the exact error the Lambda fixture hits. Deleted after debugging.
import * as AWS from "@/AWS";
import { Stream } from "@/AWS/KinesisVideo";
import * as Test from "@/Test/Vitest";
import { Endpoint } from "@distilled.cloud/aws";
import * as kv from "@distilled.cloud/aws/kinesis-video";
import * as kvam from "@distilled.cloud/aws/kinesis-video-archived-media";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

const { test } = Test.make({ providers: AWS.providers() });

test.provider(
  "probe: listFragments against an empty retained stream",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const stream = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stream("ProbeStream", {
            mediaType: "video/h264",
            dataRetention: "24 hours",
          });
        }),
      );

      const ep = yield* kv.getDataEndpoint({
        StreamARN: stream.streamArn,
        APIName: "LIST_FRAGMENTS",
      });
      const res = yield* Effect.result(
        kvam
          .listFragments({ StreamARN: stream.streamArn })
          .pipe(
            Effect.provideService(
              Endpoint.Endpoint,
              Effect.succeed(ep.DataEndpoint!),
            ),
          ),
      );
      if (Result.isSuccess(res)) {
        console.log("LISTFRAGMENTS SUCCESS", JSON.stringify(res.success));
      } else {
        console.log(
          "LISTFRAGMENTS FAILURE",
          res.failure._tag,
          JSON.stringify(res.failure),
        );
      }

      yield* stack.destroy();
    }),
  { timeout: 180_000 },
);
