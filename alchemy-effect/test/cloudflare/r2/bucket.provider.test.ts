import { CloudflareAccountId, CloudflareApi } from "@/cloudflare/api";
import * as CloudflareLive from "@/cloudflare/live";
import * as R2 from "@/cloudflare/r2";
import { apply, destroy } from "@/index";
import { test } from "@/test";
import { expect } from "@effect/vitest";
import { LogLevel } from "effect";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Schedule from "effect/Schedule";

const logLevel = Logger.withMinimumLogLevel(
  process.env.DEBUG ? LogLevel.Debug : LogLevel.Info,
);

test(
  "create, update, delete bucket",
  Effect.gen(function* () {
    const api = yield* CloudflareApi;
    const accountId = yield* CloudflareAccountId;

    {
      class TestBucket extends R2.Bucket("TestBucket", {
        name: "test-bucket-initial",
        storageClass: "Standard",
      }) {}

      const stack = yield* apply(TestBucket);

      const actualBucket = yield* api.r2.buckets.get(stack.TestBucket.name, {
        account_id: accountId,
      });
      expect(actualBucket.name).toEqual(stack.TestBucket.name);
      expect(actualBucket.storage_class).toEqual("Standard");
    }

    class TestBucket extends R2.Bucket("TestBucket", {
      name: "test-bucket-initial",
      storageClass: "InfrequentAccess",
    }) {}

    const stack = yield* apply(TestBucket);

    const actualBucket = yield* api.r2.buckets.get(stack.TestBucket.name, {
      account_id: accountId,
    });
    expect(actualBucket.name).toEqual(stack.TestBucket.name);
    expect(actualBucket.storage_class).toEqual("InfrequentAccess");

    yield* destroy();

    yield* waitForBucketToBeDeleted(stack.TestBucket.name, accountId);
  }).pipe(Effect.provide(CloudflareLive.live()), logLevel),
);

const waitForBucketToBeDeleted = Effect.fn(function* (
  bucketName: string,
  accountId: string,
) {
  const api = yield* CloudflareApi;
  yield* api.r2.buckets
    .get(bucketName, {
      account_id: accountId,
    })
    .pipe(
      Effect.flatMap(() => Effect.fail(new BucketStillExists())),
      Effect.retry({
        while: (e): e is BucketStillExists => e instanceof BucketStillExists,
        schedule: Schedule.exponential(100),
      }),
      Effect.catchTag("NotFound", () => Effect.void),
    );
});

class BucketStillExists extends Data.TaggedError("BucketStillExists") {}
