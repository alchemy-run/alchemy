import * as AWS from "@/AWS";
import * as Alchemy from "@/index.ts";
import * as State from "@/State";
import * as Test from "@/Test/Vitest";
import * as Firehose from "@distilled.cloud/aws/firehose";
import * as S3 from "@distilled.cloud/aws/s3";
import { describe, expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import FirehoseApiFunctionLive, {
  BucketAndDeliveryStream,
  FirehoseApiFunction,
} from "./handler.ts";

const providers = AWS.providers();
const state = State.localState();
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers,
  state,
});

const Stack = Alchemy.Stack(
  "firehose-bindings",
  { providers, state },
  Effect.gen(function* () {
    // Share the bucket/delivery-stream between the deployed function and the
    // stack outputs so the test can verify ingest out-of-band via distilled.
    const { bucket, deliveryStream } = yield* BucketAndDeliveryStream;
    const fn = yield* FirehoseApiFunction;
    return {
      url: fn.functionUrl.as<string>(),
      deliveryStreamName: deliveryStream.deliveryStreamName.as<string>(),
      bucketName: bucket.bucketName.as<string>(),
    };
  }).pipe(Effect.provide(FirehoseApiFunctionLive)),
);

const stack = beforeAll(deploy(Stack), { timeout: 240_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 120_000 });

// Lambda Function URLs cold-start (DNS, init) and a fresh role's IAM grants
// (eventual consistency) can both take a while on the first hit. Retrying on
// any non-200 lets the first request wait through that window; warm calls
// return on the first try and never retry.
const readinessSchedule = Schedule.fixed("2 seconds").pipe(
  Schedule.both(Schedule.recurs(75)),
);

const urlOf = (baseUrl: string, path: string) =>
  `${baseUrl.replace(/\/+$/, "")}${path}`;

const postJson = (baseUrl: string, path: string, body: unknown) =>
  HttpClient.execute(
    HttpClientRequest.bodyJsonUnsafe(
      HttpClientRequest.post(urlOf(baseUrl, path)),
      body,
    ),
  ).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? response.json
        : Effect.fail(new Error(`Request failed: ${response.status}`)),
    ),
    Effect.retry({ schedule: readinessSchedule }),
  );

describe("Firehose Bindings", () => {
  describe("PutRecord", () => {
    // `test.provider` supplies the AWS environment for the out-of-band
    // describeDeliveryStream verification via distilled.
    test.provider("writes a single record and the stream stays ACTIVE", () =>
      Effect.gen(function* () {
        const { url, deliveryStreamName } = yield* stack;
        const response = yield* postJson(url, "/put-record", {
          data: `put-record-${crypto.randomUUID()}`,
        });
        expect((response as any).RecordId).toBeTruthy();

        // Ingest success is the assertion — S3 delivery is asynchronous
        // (buffering ≥ 60s), so verify the stream is ACTIVE out-of-band
        // instead of waiting for objects to land.
        const described = yield* Firehose.describeDeliveryStream({
          DeliveryStreamName: deliveryStreamName,
        });
        expect(
          described.DeliveryStreamDescription.DeliveryStreamStatus,
        ).toEqual("ACTIVE");
      }),
    );
  });

  describe("PutRecordBatch", () => {
    test(
      "writes a batch of records with zero failures",
      Effect.gen(function* () {
        const { url } = yield* stack;
        const response = yield* postJson(url, "/put-record-batch", {
          records: [
            `batch-1-${crypto.randomUUID()}`,
            `batch-2-${crypto.randomUUID()}`,
            `batch-3-${crypto.randomUUID()}`,
          ],
        });
        expect((response as any).FailedPutCount).toBe(0);
        const entries = (response as any).RequestResponses ?? [];
        expect(entries.length).toBe(3);
        for (const entry of entries) {
          expect(entry.RecordId).toBeTruthy();
          expect(entry.ErrorCode).toBeUndefined();
        }
      }),
    );
  });

  // S3 arrival proof is gated: Firehose buffers for ≥ 60s before delivering,
  // which busts the speed doctrine for the default suite. Run with
  // AWS_TEST_SLOW=1 to verify end-to-end delivery with bounded polling.
  describe.skipIf(!process.env.AWS_TEST_SLOW)("S3 delivery (slow)", () => {
    class NoObjectsYet extends Data.TaggedError("NoObjectsYet") {}

    test.provider(
      "delivers buffered records to the destination bucket",
      () =>
        Effect.gen(function* () {
          const { url, bucketName } = yield* stack;
          yield* postJson(url, "/put-record", {
            data: `s3-delivery-${crypto.randomUUID()}`,
          });

          const listing = yield* S3.listObjectsV2({
            Bucket: bucketName,
            Prefix: "records/",
          }).pipe(
            Effect.flatMap((result) =>
              (result.KeyCount ?? 0) > 0
                ? Effect.succeed(result)
                : Effect.fail(new NoObjectsYet()),
            ),
            Effect.retry({
              while: (e: { _tag: string }) => e._tag === "NoObjectsYet",
              schedule: Schedule.fixed("10 seconds").pipe(
                Schedule.both(Schedule.recurs(12)),
              ),
            }),
          );
          expect(listing.KeyCount ?? 0).toBeGreaterThan(0);
        }),
      { timeout: 180_000 },
    );
  });
});
