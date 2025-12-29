import * as AWS from "@/aws";
import * as S3 from "@/aws/s3";
import { apply, destroy } from "@/index";
import { test } from "@/test";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/**
 * S3 Bucket Resource Provider Test Cases
 *
 * These tests verify the lifecycle operations (create, read, update, delete)
 * for the S3 Bucket resource provider.
 *
 * Test Categories:
 * 1. Basic Create Tests - Simple bucket creation scenarios
 * 2. Naming Tests - Bucket name generation and prefix scenarios
 * 3. Tag Tests - Tag management scenarios
 * 4. Force Destroy Tests - Deletion scenarios involving bucket contents
 * 5. Object Lock Tests - Object Lock configuration scenarios
 * 6. Multi-Step Update Tests - Update and replacement scenarios
 */

// ============================================================================
// Test Helpers
// ============================================================================

class BucketStillExists extends Data.TaggedError("BucketStillExists")<{
  bucket: string;
}> {}

/**
 * Assert that a bucket has been deleted by polling HeadBucket until NotFound.
 */
const assertBucketDeleted = Effect.fn(function* (bucketName: string) {
  const s3 = yield* S3.S3Client;
  yield* s3.headBucket({ Bucket: bucketName }).pipe(
    Effect.flatMap(() =>
      Effect.fail(new BucketStillExists({ bucket: bucketName })),
    ),
    Effect.retry({
      while: (e) => e instanceof BucketStillExists,
      schedule: Schedule.exponential(500).pipe(
        Schedule.intersect(Schedule.recurs(20)),
      ),
    }),
    Effect.catchTag("NotFound", () => Effect.void),
  );
});

/**
 * Upload a simple object to a bucket for testing forceDestroy scenarios.
 */
const uploadTestObject = Effect.fn(function* (
  bucketName: string,
  key: string,
  body: string,
) {
  const s3 = yield* S3.S3Client;
  yield* s3.putObject({
    Bucket: bucketName,
    Key: key,
    Body: body,
  });
});

/**
 * Get bucket tags and return as a simple object.
 */
const getBucketTags = Effect.fn(function* (bucketName: string) {
  const s3 = yield* S3.S3Client;
  return yield* s3.getBucketTagging({ Bucket: bucketName }).pipe(
    Effect.map((r) =>
      Object.fromEntries((r.TagSet ?? []).map((t) => [t.Key!, t.Value!])),
    ),
    Effect.catchTag("NoSuchTagSet", () =>
      Effect.succeed({} as Record<string, string>),
    ),
    Effect.catchTag("NoSuchTagSetError", () =>
      Effect.succeed({} as Record<string, string>),
    ),
  );
});

// ============================================================================
// 1. Basic Create Tests
// ============================================================================

/**
 * Test: Create Bucket with Auto-generated Name
 *
 * Purpose: Verify bucket creation when no bucket name or prefix is provided,
 * triggering automatic name generation.
 *
 * Steps:
 * 1. Create a bucket without specifying bucket or bucketPrefix
 * 2. Verify the bucket exists via HeadBucket
 * 3. Verify output attributes are correctly populated
 * 4. Delete the bucket
 * 5. Verify the bucket no longer exists
 *
 * Expected: Bucket is created with auto-generated name and deleted successfully.
 */
test(
  "create, delete bucket with auto-generated name",
  Effect.gen(function* () {
    const s3 = yield* S3.S3Client;

    class TestBucket extends S3.Bucket("TestBucket", {}) {}

    const stack = yield* apply(TestBucket);

    // Verify the bucket was created with generated name
    expect(stack.TestBucket.bucket).toBeDefined();
    expect(stack.TestBucket.bucket.length).toBeGreaterThan(0);

    // Verify output attributes
    expect(stack.TestBucket.arn).toEqual(
      `arn:aws:s3:::${stack.TestBucket.bucket}`,
    );
    expect(stack.TestBucket.bucketDomainName).toEqual(
      `${stack.TestBucket.bucket}.s3.amazonaws.com`,
    );
    expect(stack.TestBucket.bucketRegion).toBeDefined();
    expect(stack.TestBucket.hostedZoneId).toBeDefined();

    // Verify the bucket exists via HeadBucket
    yield* s3.headBucket({ Bucket: stack.TestBucket.bucket });

    yield* destroy();

    yield* assertBucketDeleted(stack.TestBucket.bucket);
  }).pipe(Effect.provide(AWS.providers())),
);

/**
 * Test: Create Bucket with Explicit Name
 *
 * Purpose: Verify basic bucket creation with an explicitly provided bucket name.
 *
 * Steps:
 * 1. Create a bucket with an explicit bucket name
 * 2. Verify the bucket exists via HeadBucket
 * 3. Verify all output attributes are correctly populated
 * 4. Delete the bucket
 * 5. Verify the bucket no longer exists
 *
 * Expected: Bucket is created with exact name and all attributes correctly populated.
 */
test(
  "create, delete bucket with explicit name",
  Effect.gen(function* () {
    const s3 = yield* S3.S3Client;

    // Generate a unique bucket name using timestamp
    const bucketName = `alchemy-test-explicit-${Date.now()}`;

    class TestBucket extends S3.Bucket("TestBucket", {
      bucket: bucketName,
    }) {}

    const stack = yield* apply(TestBucket);

    // Verify the bucket name matches
    expect(stack.TestBucket.bucket).toEqual(bucketName);

    // Verify output attributes
    expect(stack.TestBucket.arn).toEqual(`arn:aws:s3:::${bucketName}`);
    expect(stack.TestBucket.bucketDomainName).toEqual(
      `${bucketName}.s3.amazonaws.com`,
    );
    expect(stack.TestBucket.id).toEqual(bucketName);

    // Verify the bucket exists
    yield* s3.headBucket({ Bucket: bucketName });

    yield* destroy();

    yield* assertBucketDeleted(bucketName);
  }).pipe(Effect.provide(AWS.providers())),
);

/**
 * Test: Create Bucket with Prefix
 *
 * Purpose: Verify bucket creation using the bucketPrefix property.
 *
 * Steps:
 * 1. Create a bucket with a bucket prefix
 * 2. Verify the bucket name starts with the prefix
 * 3. Verify the bucket exists via HeadBucket
 * 4. Delete the bucket
 * 5. Verify the bucket no longer exists
 *
 * Expected: Bucket is created with name starting with prefix and unique suffix.
 */
test(
  "create, delete bucket with prefix",
  Effect.gen(function* () {
    const s3 = yield* S3.S3Client;

    const prefix = "alchemy-test-prefix-";

    class TestBucket extends S3.Bucket("TestBucket", {
      bucketPrefix: prefix,
    }) {}

    const stack = yield* apply(TestBucket);

    // Verify the bucket name starts with the prefix
    expect(stack.TestBucket.bucket).toMatch(new RegExp(`^${prefix}`));
    expect(stack.TestBucket.bucketPrefix).toEqual(prefix);

    // Verify the bucket exists
    yield* s3.headBucket({ Bucket: stack.TestBucket.bucket });

    yield* destroy();

    yield* assertBucketDeleted(stack.TestBucket.bucket);
  }).pipe(Effect.provide(AWS.providers())),
);

// ============================================================================
// 2. Tag Tests
// ============================================================================

/**
 * Test: Create Bucket with Tags and Update Tags
 *
 * Purpose: Verify tag creation and update operations.
 *
 * Steps:
 * 1. Create a bucket with initial tags
 * 2. Verify tags are set correctly
 * 3. Update the bucket with modified tags (add, modify, remove)
 * 4. Verify updated tags
 * 5. Delete the bucket
 *
 * Expected: Tags are correctly added, modified, and removed through update operations.
 */
test(
  "create bucket with tags, update tags",
  Effect.gen(function* () {
    // Create bucket with initial tags
    class TestBucket extends S3.Bucket("TestBucket", {
      tags: {
        Key1: "Value1",
        Key2: "Value2",
        Key3: "Value3",
      },
    }) {}

    const stack = yield* apply(TestBucket);

    // Verify initial tags (should include alchemy tags + user tags)
    const initialTags = yield* getBucketTags(stack.TestBucket.bucket);
    expect(initialTags["Key1"]).toEqual("Value1");
    expect(initialTags["Key2"]).toEqual("Value2");
    expect(initialTags["Key3"]).toEqual("Value3");

    // Update tags: remove Key1, modify Key3, add Key4
    class UpdatedBucket extends S3.Bucket("TestBucket", {
      tags: {
        Key2: "Value2",
        Key3: "ModifiedValue3",
        Key4: "Value4",
      },
    }) {}

    const updatedStack = yield* apply(UpdatedBucket);

    // Verify bucket wasn't replaced (same bucket name)
    expect(updatedStack.TestBucket.bucket).toEqual(stack.TestBucket.bucket);

    // Verify updated tags
    const updatedTags = yield* getBucketTags(stack.TestBucket.bucket);
    expect(updatedTags["Key1"]).toBeUndefined();
    expect(updatedTags["Key2"]).toEqual("Value2");
    expect(updatedTags["Key3"]).toEqual("ModifiedValue3");
    expect(updatedTags["Key4"]).toEqual("Value4");

    yield* destroy();

    yield* assertBucketDeleted(stack.TestBucket.bucket);
  }).pipe(Effect.provide(AWS.providers())),
);

// ============================================================================
// 3. Force Destroy Tests
// ============================================================================

/**
 * Test: Force Destroy with Objects
 *
 * Purpose: Verify forceDestroy=true allows deletion of non-empty buckets.
 *
 * Steps:
 * 1. Create a bucket with forceDestroy set to true
 * 2. Upload multiple objects to the bucket
 * 3. Delete the bucket
 * 4. Verify all objects are deleted
 * 5. Verify the bucket no longer exists
 *
 * Expected: Bucket and all objects are successfully deleted.
 */
test(
  "force destroy with objects",
  Effect.gen(function* () {
    class TestBucket extends S3.Bucket("TestBucket", {
      forceDestroy: true,
    }) {}

    const stack = yield* apply(TestBucket);

    // Upload test objects
    yield* uploadTestObject(stack.TestBucket.bucket, "file1.txt", "content1");
    yield* uploadTestObject(
      stack.TestBucket.bucket,
      "folder/file2.txt",
      "content2",
    );
    yield* uploadTestObject(
      stack.TestBucket.bucket,
      "folder/subfolder/file3.txt",
      "content3",
    );

    yield* destroy();

    yield* assertBucketDeleted(stack.TestBucket.bucket);
  }).pipe(Effect.provide(AWS.providers())),
);

/**
 * Test: Update forceDestroy Property
 *
 * Purpose: Verify forceDestroy can be updated without bucket replacement.
 *
 * Steps:
 * 1. Create a bucket with forceDestroy=false
 * 2. Update to forceDestroy=true
 * 3. Verify bucket wasn't replaced (same ID)
 * 4. Upload an object
 * 5. Delete the bucket (should succeed due to forceDestroy=true)
 *
 * Expected: forceDestroy is updated in-place without replacement.
 */
test(
  "update forceDestroy property",
  Effect.gen(function* () {
    // Create without forceDestroy
    class TestBucket extends S3.Bucket("TestBucket", {
      forceDestroy: false,
    }) {}

    const stack = yield* apply(TestBucket);
    const originalBucket = stack.TestBucket.bucket;

    // Update to enable forceDestroy
    class UpdatedBucket extends S3.Bucket("TestBucket", {
      forceDestroy: true,
    }) {}

    const updatedStack = yield* apply(UpdatedBucket);

    // Verify no replacement (same bucket)
    expect(updatedStack.TestBucket.bucket).toEqual(originalBucket);

    // Upload an object
    yield* uploadTestObject(originalBucket, "test.txt", "test content");

    // Delete should succeed because forceDestroy is now true
    yield* destroy();

    yield* assertBucketDeleted(originalBucket);
  }).pipe(Effect.provide(AWS.providers())),
);

// ============================================================================
// 4. Object Lock Tests
// ============================================================================

/**
 * Test: Create Bucket with Object Lock Enabled
 *
 * Purpose: Verify bucket creation with Object Lock enabled at creation time.
 *
 * Steps:
 * 1. Create a bucket with objectLockEnabled=true
 * 2. Verify Object Lock is enabled via GetObjectLockConfiguration
 * 3. Verify the objectLockEnabled output attribute
 * 4. Delete the bucket
 *
 * Expected: Bucket is created with Object Lock enabled.
 */
test(
  "create bucket with object lock enabled",
  Effect.gen(function* () {
    const s3 = yield* S3.S3Client;

    class TestBucket extends S3.Bucket("TestBucket", {
      objectLockEnabled: true,
      forceDestroy: true, // Enable for cleanup
    }) {}

    const stack = yield* apply(TestBucket);

    // Verify Object Lock is enabled
    expect(stack.TestBucket.objectLockEnabled).toBe(true);

    // Verify via API
    const lockConfig = yield* s3.getObjectLockConfiguration({
      Bucket: stack.TestBucket.bucket,
    });
    expect(lockConfig.ObjectLockConfiguration?.ObjectLockEnabled).toEqual(
      "Enabled",
    );

    yield* destroy();

    yield* assertBucketDeleted(stack.TestBucket.bucket);
  }).pipe(Effect.provide(AWS.providers())),
);

// ============================================================================
// 5. Multi-Step Update Tests
// ============================================================================

/**
 * Test: Bucket Name Change Triggers Replacement
 *
 * Purpose: Verify that changing bucket name triggers bucket replacement.
 *
 * Steps:
 * 1. Create a bucket with name "bucket-a"
 * 2. Change to a different explicit bucket name "bucket-b"
 * 3. Verify replacement occurred (new bucket name)
 * 4. Verify old bucket is deleted
 * 5. Delete new bucket
 *
 * Expected: Bucket name change creates new bucket and deletes old one.
 */
test(
  "bucket name change triggers replacement",
  Effect.gen(function* () {
    const s3 = yield* S3.S3Client;

    const bucketNameA = `alchemy-test-replace-a-${Date.now()}`;
    const bucketNameB = `alchemy-test-replace-b-${Date.now()}`;

    // Create first bucket
    class BucketA extends S3.Bucket("TestBucket", {
      bucket: bucketNameA,
    }) {}

    const stackA = yield* apply(BucketA);
    expect(stackA.TestBucket.bucket).toEqual(bucketNameA);

    // Verify bucket A exists
    yield* s3.headBucket({ Bucket: bucketNameA });

    // Change to bucket B (triggers replacement)
    class BucketB extends S3.Bucket("TestBucket", {
      bucket: bucketNameB,
    }) {}

    const stackB = yield* apply(BucketB);

    // Verify new bucket was created
    expect(stackB.TestBucket.bucket).toEqual(bucketNameB);

    // Verify bucket B exists
    yield* s3.headBucket({ Bucket: bucketNameB });

    // Verify old bucket A was deleted
    yield* assertBucketDeleted(bucketNameA);

    yield* destroy();

    yield* assertBucketDeleted(bucketNameB);
  }).pipe(Effect.provide(AWS.providers())),
);

/**
 * Test: Bucket Prefix Change Triggers Replacement
 *
 * Purpose: Verify that changing bucketPrefix triggers bucket replacement.
 *
 * Steps:
 * 1. Create a bucket with prefix "prefix-a-"
 * 2. Change to prefix "prefix-b-"
 * 3. Verify replacement occurred (new bucket name)
 *
 * Expected: bucketPrefix change creates new bucket since computed name differs.
 */
test(
  "bucket prefix change triggers replacement",
  Effect.gen(function* () {
    const s3 = yield* S3.S3Client;

    const prefixA = "alchemy-test-prefixa-";
    const prefixB = "alchemy-test-prefixb-";

    // Create bucket with prefix A
    class BucketA extends S3.Bucket("TestBucket", {
      bucketPrefix: prefixA,
    }) {}

    const stackA = yield* apply(BucketA);
    const bucketNameA = stackA.TestBucket.bucket;
    expect(bucketNameA).toMatch(new RegExp(`^${prefixA}`));

    // Verify bucket A exists
    yield* s3.headBucket({ Bucket: bucketNameA });

    // Change to prefix B (triggers replacement)
    class BucketB extends S3.Bucket("TestBucket", {
      bucketPrefix: prefixB,
    }) {}

    const stackB = yield* apply(BucketB);
    const bucketNameB = stackB.TestBucket.bucket;

    // Verify new bucket was created with new prefix
    expect(bucketNameB).toMatch(new RegExp(`^${prefixB}`));
    expect(bucketNameB).not.toEqual(bucketNameA);

    // Verify bucket B exists
    yield* s3.headBucket({ Bucket: bucketNameB });

    // Verify old bucket A was deleted
    yield* assertBucketDeleted(bucketNameA);

    yield* destroy();

    yield* assertBucketDeleted(bucketNameB);
  }).pipe(Effect.provide(AWS.providers())),
);

// ============================================================================
// 6. Force Destroy with Versioned Objects
// ============================================================================

/**
 * Test: Force Destroy with Versioned Objects
 *
 * Purpose: Verify forceDestroy deletes all object versions and delete markers.
 *
 * Steps:
 * 1. Create a bucket with forceDestroy and versioning enabled
 * 2. Upload an object
 * 3. Delete the object (creates delete marker)
 * 4. Upload the object again (creates new version)
 * 5. Delete the bucket
 * 6. Verify all versions and markers are deleted
 *
 * Expected: All object versions and delete markers are cleaned up.
 */
test(
  "force destroy with versioned objects",
  Effect.gen(function* () {
    const s3 = yield* S3.S3Client;

    // Create bucket with object lock (implicitly enables versioning)
    // Or we could use a separate BucketVersioning resource
    class TestBucket extends S3.Bucket("TestBucket", {
      objectLockEnabled: true, // Versioning is automatically enabled with Object Lock
      forceDestroy: true,
    }) {}

    const stack = yield* apply(TestBucket);

    // Upload initial version
    yield* s3.putObject({
      Bucket: stack.TestBucket.bucket,
      Key: "versioned-file.txt",
      Body: "version 1",
    });

    // Upload second version
    yield* s3.putObject({
      Bucket: stack.TestBucket.bucket,
      Key: "versioned-file.txt",
      Body: "version 2",
    });

    // Delete the object (creates delete marker)
    yield* s3.deleteObject({
      Bucket: stack.TestBucket.bucket,
      Key: "versioned-file.txt",
    });

    // Upload again (creates another version)
    yield* s3.putObject({
      Bucket: stack.TestBucket.bucket,
      Key: "versioned-file.txt",
      Body: "version 3",
    });

    // Destroy should clean up all versions and delete markers
    yield* destroy();

    yield* assertBucketDeleted(stack.TestBucket.bucket);
  }).pipe(Effect.provide(AWS.providers())),
);

// ============================================================================
// 7. Region-Specific Tests
// ============================================================================

/**
 * Test: Bucket Regional Domain Name
 *
 * Purpose: Verify regional domain name is correctly computed.
 *
 * Steps:
 * 1. Create a bucket
 * 2. Verify bucketRegionalDomainName format
 *
 * Expected: Regional domain name follows format {bucket}.s3.{region}.amazonaws.com
 */
test(
  "bucket regional domain name",
  Effect.gen(function* () {
    class TestBucket extends S3.Bucket("TestBucket", {}) {}

    const stack = yield* apply(TestBucket);

    // Verify regional domain name format
    expect(stack.TestBucket.bucketRegionalDomainName).toEqual(
      `${stack.TestBucket.bucket}.s3.${stack.TestBucket.bucketRegion}.amazonaws.com`,
    );

    yield* destroy();

    yield* assertBucketDeleted(stack.TestBucket.bucket);
  }).pipe(Effect.provide(AWS.providers())),
);
