// Probe: why does /jobs/stop-not-found-all die? Run every Stop*Job with a
// bogus JobId and print the raw failure.
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

const BOGUS_JOB_ID = "00000000000000000000000000000000";

const show = (label: string, r: Result.Result<unknown, unknown>) => {
  if (Result.isSuccess(r)) {
    console.log(label, "OK", JSON.stringify(r.success).slice(0, 300));
  } else {
    console.log(label, "ERR", JSON.stringify(r.failure).slice(0, 400));
  }
};

const main = Effect.gen(function* () {
  show(
    "dominantLanguage",
    yield* Effect.result(
      comprehend.stopDominantLanguageDetectionJob({ JobId: BOGUS_JOB_ID }),
    ),
  );
  show(
    "entities",
    yield* Effect.result(
      comprehend.stopEntitiesDetectionJob({ JobId: BOGUS_JOB_ID }),
    ),
  );
  show(
    "events",
    yield* Effect.result(
      comprehend.stopEventsDetectionJob({ JobId: BOGUS_JOB_ID }),
    ),
  );
  show(
    "keyPhrases",
    yield* Effect.result(
      comprehend.stopKeyPhrasesDetectionJob({ JobId: BOGUS_JOB_ID }),
    ),
  );
  show(
    "piiEntities",
    yield* Effect.result(
      comprehend.stopPiiEntitiesDetectionJob({ JobId: BOGUS_JOB_ID }),
    ),
  );
  show(
    "sentiment",
    yield* Effect.result(
      comprehend.stopSentimentDetectionJob({ JobId: BOGUS_JOB_ID }),
    ),
  );
  show(
    "targetedSentiment",
    yield* Effect.result(
      comprehend.stopTargetedSentimentDetectionJob({ JobId: BOGUS_JOB_ID }),
    ),
  );
});

await Effect.runPromise(main.pipe(Effect.provide(runtime)));
