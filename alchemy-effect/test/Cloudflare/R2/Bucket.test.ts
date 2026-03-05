import { Account } from "@/Cloudflare/Account";
import { CloudflareApi } from "@/Cloudflare/CloudflareApi";
import * as Cloudflare from "@/Cloudflare";
import * as R2 from "@/Cloudflare/R2/index";
import { destroy } from "@/Destroy";
import { test } from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

test(
  "create and delete bucket with default props",
  Effect.gen(function* () {
    const api = yield* CloudflareApi;
    const accountId = yield* Account;

    yield* destroy();

    const bucket = yield* test.deploy(
      Effect.gen(function* () {
        return yield* R2.Bucket("DefaultBucket");
      }),
    );

    expect(bucket.bucketName).toBeDefined();
    expect(bucket.storageClass).toEqual("Standard");
    expect(bucket.jurisdiction).toEqual("default");

    const actualBucket = yield* api.r2.buckets.get(bucket.bucketName, {
      account_id: accountId,
    });
    expect(actualBucket.name).toEqual(bucket.bucketName);

    yield* destroy();

    yield* waitForBucketToBeDeleted(bucket.bucketName, accountId);
  }).pipe(Effect.provide(Cloudflare.providers()), logLevel),
);

test(
  "create, update, delete bucket",
  Effect.gen(function* () {
    const api = yield* CloudflareApi;
    const accountId = yield* Account;

    yield* destroy();

    const bucket = yield* test.deploy(
      Effect.gen(function* () {
        return yield* R2.Bucket("TestBucket", {
          name: "test-bucket-initial",
          storageClass: "Standard",
        });
      }),
    );

    const actualBucket = yield* api.r2.buckets.get(bucket.bucketName, {
      account_id: accountId,
    });
    expect(actualBucket.name).toEqual(bucket.bucketName);
    expect(actualBucket.storage_class).toEqual("Standard");

    // Update the bucket
    const updatedBucket = yield* test.deploy(
      Effect.gen(function* () {
        return yield* R2.Bucket("TestBucket", {
          name: "test-bucket-initial",
          storageClass: "InfrequentAccess",
        });
      }),
    );

    const actualUpdatedBucket = yield* api.r2.buckets.get(
      updatedBucket.bucketName,
      {
        account_id: accountId,
      },
    );
    expect(actualUpdatedBucket.name).toEqual(updatedBucket.bucketName);
    expect(actualUpdatedBucket.storage_class).toEqual("InfrequentAccess");

    yield* destroy();

    yield* waitForBucketToBeDeleted(bucket.bucketName, accountId);
  }).pipe(Effect.provide(Cloudflare.providers()), logLevel),
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
