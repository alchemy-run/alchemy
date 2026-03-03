import { RemovalPolicy } from "alchemy-effect";
import * as Lambda from "alchemy-effect/AWS/Lambda";
import * as S3 from "alchemy-effect/AWS/S3";
import * as SQS from "alchemy-effect/AWS/SQS";
import * as Http from "alchemy-effect/Http";
import { Stack } from "alchemy-effect/Stack";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { JobHttpEffect } from "./JobHttpApi.ts";
import { JobStorage, JobStorageLive } from "./JobStorage.ts";

// ## sync drift
// alchemy sync
// alchemy sync ./alchemy.run.ts
// alchemy sync ./alchemy.run.ts --no-adopt (default)
// alchemy sync ./alchemy.run.ts --stack

// ## adopt resources
// alchemy sync
// alchemy sync --adopt (all)
// alchemy sync ./alchemy.run.ts --adopt (all)
// alchemy sync ./alchemy.run.ts --adopt JobsQueue,JobsDatabase

// ## deploy
// alchemy deploy
// alchemy deploy --adopt
// alchemy deploy --dry-run --adopt
// alchemy deploy --dry-run --adopt JobsQueue,JobsDatabase

const JobFunction = Effect.gen(function* () {
  const stack = yield* Stack;

  const { bucket, getJob } = yield* JobStorage;

  const queue = yield* SQS.Queue("JobsQueue").pipe(
    RemovalPolicy.retain(stack.stage === "prod"),
  );

  // Sink
  const sink = yield* SQS.QueueSink.bind(queue);

  // register a HTTP server in the Lambda Function runtime
  yield* Http.serve(yield* JobHttpEffect);
  // if you want to use RPC instead of HttpApi:
  // yield* Http.serve(yield* JobRpcHttpEffect);

  // register a SQS Event Handler in the Lambda Function runtime
  yield* S3.notifications(bucket).subscribe((stream) =>
    stream.pipe(
      Stream.flatMap((item) =>
        Stream.fromEffect(getJob(item.key).pipe(Effect.orDie)),
      ),
      Stream.map((msg) => JSON.stringify(msg)),
      Stream.tapSink(sink),
      Stream.runDrain,
    ),
  );

  // return the Function properties for this stage
  return {
    main: import.meta.filename,
    memory: 1024,
    url: true,
  } as const;
}).pipe(
  Effect.provide(
    Layer.mergeAll(
      JobStorageLive,
      Lambda.BucketEventSource,
      Lambda.HttpServer,
      SQS.QueueSinkLive,
    ).pipe(
      Layer.provide(S3.PutObjectLive),
      Layer.provide(S3.GetObjectLive),
      Layer.provide(SQS.SendMessageBatchLive),
    ),
  ),
  Lambda.Function("JobFunction"),
);

export default JobFunction;
