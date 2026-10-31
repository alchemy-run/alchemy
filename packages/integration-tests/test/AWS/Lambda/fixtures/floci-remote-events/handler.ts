import * as Lambda from "@alchemy.run/aws/Lambda";
import * as S3 from "@alchemy.run/aws/S3";
import * as SQS from "@alchemy.run/aws/SQS";
import * as Alchemy from "alchemy";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

// Notifications watch `uploads/`; the handlers write elsewhere, so they
// never trigger themselves.
const UPLOADS = "uploads/";

/**
 * A Lambda emulated by floci under `alchemy dev` whose event sources live in
 * the real cloud: a queue (a pull source, read by an event-source mapping)
 * and bucket notifications (a push source). Each handler records what it
 * received in the real bucket.
 */
export class RemoteEventsFunction extends Lambda.Function<RemoteEventsFunction>()(
  "RemoteEventsFunction",
) {}

export default RemoteEventsFunction.make(
  { main: import.meta.url, functionUrl: true, timeout: Duration.seconds(30) },
  Effect.gen(function* () {
    const bucket = yield* S3.Bucket("RemoteEventsBucket", { forceDestroy: true }).pipe(
      Alchemy.remote(),
    );
    const queue = yield* SQS.Queue("RemoteEventsQueue").pipe(Alchemy.remote());
    const putObject = yield* S3.PutObject(bucket);
    const bucketName = yield* bucket.bucketName;
    const queueUrl = yield* queue.queueUrl;

    yield* SQS.consumeQueueMessages(
      queue,
      { batchSize: 1 },
      Effect.fn(function* (event) {
        for (const record of event.Records) {
          yield* putObject({ Key: `received/${record.body}`, Body: record.body });
        }
      }),
    );

    yield* S3.consumeBucketEvents(
      bucket,
      { events: ["s3:ObjectCreated:*"], prefix: UPLOADS },
      (events) =>
        events.pipe(
          Stream.runForEach((event) =>
            putObject({ Key: `seen/${event.key.slice(UPLOADS.length)}`, Body: event.key }),
          ),
          Effect.orDie,
        ),
    );

    return {
      fetch: Effect.gen(function* () {
        yield* HttpServerRequest;
        return yield* HttpServerResponse.json({
          bucketName: yield* bucketName,
          queueUrl: yield* queueUrl,
        });
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(Lambda.QueueEventSource, Lambda.BucketEventSource, S3.PutObjectHttp),
    ),
  ),
);
