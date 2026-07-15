import * as Credentials from "@distilled.cloud/aws/Credentials";
import * as comprehend from "@distilled.cloud/aws/comprehend";
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
  Layer.succeed(Region, "us-west-2"),
);

const main = Effect.gen(function* () {
  const r1 = yield* Effect.result(
    comprehend.detectSentiment({ Text: "I love it", LanguageCode: "en" }),
  );
  console.log(
    "detectSentiment",
    Result.isSuccess(r1)
      ? JSON.stringify(r1.success)
      : JSON.stringify(r1.failure),
  );
  const r2 = yield* Effect.result(
    comprehend.describeSentimentDetectionJob({
      JobId: "00000000000000000000000000000000",
    }),
  );
  console.log(
    "describeSentimentJob",
    Result.isSuccess(r2)
      ? JSON.stringify(r2.success)
      : JSON.stringify(r2.failure),
  );
  const r3 = yield* Effect.result(
    comprehend.stopSentimentDetectionJob({
      JobId: "00000000000000000000000000000000",
    }),
  );
  console.log(
    "stopSentimentJob",
    Result.isSuccess(r3)
      ? JSON.stringify(r3.success)
      : JSON.stringify(r3.failure),
  );
});

await Effect.runPromise(main.pipe(Effect.provide(runtime)));
