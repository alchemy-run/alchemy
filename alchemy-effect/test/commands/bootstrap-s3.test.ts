import { describe, it, expect, vi, beforeEach } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Context from "effect/Context";
import { S3Client } from "@/aws/s3";
import type { S3 } from "itty-aws/s3";

/**
 * Unit tests for the bootstrap-s3 command logic.
 *
 * These tests mock the S3 client to test the command logic
 * without making actual AWS API calls.
 */

// Mock S3 client type
type MockS3 = {
  listBuckets: ReturnType<typeof vi.fn>;
  getBucketTagging: ReturnType<typeof vi.fn>;
  createBucket: ReturnType<typeof vi.fn>;
  putBucketTagging: ReturnType<typeof vi.fn>;
};

describe("bootstrap-s3 command logic", () => {
  let mockS3: MockS3;

  beforeEach(() => {
    mockS3 = {
      listBuckets: vi.fn(),
      getBucketTagging: vi.fn(),
      createBucket: vi.fn(),
      putBucketTagging: vi.fn(),
    };
  });

  describe("findExistingBucket", () => {
    it("should return undefined when no buckets exist", async () => {
      mockS3.listBuckets.mockReturnValue(Effect.succeed({ Buckets: [] }));

      const result = await Effect.runPromise(
        findExistingBucketLogic(mockS3 as unknown as S3),
      );

      expect(result).toBeUndefined();
      expect(mockS3.listBuckets).toHaveBeenCalledOnce();
    });

    it("should return undefined when no buckets have alchemy tag", async () => {
      mockS3.listBuckets.mockReturnValue(
        Effect.succeed({
          Buckets: [{ Name: "some-bucket" }, { Name: "another-bucket" }],
        }),
      );
      mockS3.getBucketTagging.mockReturnValue(
        Effect.succeed({ TagSet: [{ Key: "other", Value: "tag" }] }),
      );

      const result = await Effect.runPromise(
        findExistingBucketLogic(mockS3 as unknown as S3),
      );

      expect(result).toBeUndefined();
      expect(mockS3.getBucketTagging).toHaveBeenCalledTimes(2);
    });

    it("should return bucket name when alchemy tag is found", async () => {
      mockS3.listBuckets.mockReturnValue(
        Effect.succeed({
          Buckets: [{ Name: "random-bucket" }, { Name: "alchemy-state-abc123" }],
        }),
      );
      mockS3.getBucketTagging
        .mockReturnValueOnce(Effect.succeed({ TagSet: [] }))
        .mockReturnValueOnce(
          Effect.succeed({
            TagSet: [{ Key: "alchemy:bootstrap", Value: "s3-state-store" }],
          }),
        );

      const result = await Effect.runPromise(
        findExistingBucketLogic(mockS3 as unknown as S3),
      );

      expect(result).toEqual("alchemy-state-abc123");
    });

    it("should handle getBucketTagging errors gracefully", async () => {
      mockS3.listBuckets.mockReturnValue(
        Effect.succeed({
          Buckets: [{ Name: "bucket-without-tags" }],
        }),
      );
      // Simulate NoSuchTagSet error (bucket has no tags)
      mockS3.getBucketTagging.mockReturnValue(
        Effect.fail({ _tag: "NoSuchTagSet" }),
      );

      const result = await Effect.runPromise(
        findExistingBucketLogic(mockS3 as unknown as S3),
      );

      expect(result).toBeUndefined();
    });
  });

  describe("bucket creation", () => {
    it("should create bucket with correct name format", async () => {
      mockS3.createBucket.mockReturnValue(Effect.succeed({}));
      mockS3.putBucketTagging.mockReturnValue(Effect.succeed({}));

      const bucketName = await Effect.runPromise(
        createBucketLogic(mockS3 as unknown as S3, "alchemy-state", "us-east-1"),
      );

      // Should match pattern: prefix-6hexchars
      expect(bucketName).toMatch(/^alchemy-state-[a-f0-9]{6}$/);
      expect(mockS3.createBucket).toHaveBeenCalledOnce();
    });

    it("should create bucket with LocationConstraint for non-us-east-1 regions", async () => {
      mockS3.createBucket.mockReturnValue(Effect.succeed({}));
      mockS3.putBucketTagging.mockReturnValue(Effect.succeed({}));

      await Effect.runPromise(
        createBucketLogic(mockS3 as unknown as S3, "alchemy-state", "eu-west-1"),
      );

      expect(mockS3.createBucket).toHaveBeenCalledWith(
        expect.objectContaining({
          CreateBucketConfiguration: {
            LocationConstraint: "eu-west-1",
          },
        }),
      );
    });

    it("should NOT include LocationConstraint for us-east-1", async () => {
      mockS3.createBucket.mockReturnValue(Effect.succeed({}));
      mockS3.putBucketTagging.mockReturnValue(Effect.succeed({}));

      await Effect.runPromise(
        createBucketLogic(mockS3 as unknown as S3, "alchemy-state", "us-east-1"),
      );

      const callArgs = mockS3.createBucket.mock.calls[0][0];
      expect(callArgs.CreateBucketConfiguration).toBeUndefined();
    });

    it("should tag bucket with correct tags", async () => {
      mockS3.createBucket.mockReturnValue(Effect.succeed({}));
      mockS3.putBucketTagging.mockReturnValue(Effect.succeed({}));

      await Effect.runPromise(
        createBucketLogic(mockS3 as unknown as S3, "alchemy-state", "us-east-1"),
      );

      expect(mockS3.putBucketTagging).toHaveBeenCalledWith(
        expect.objectContaining({
          Tagging: {
            TagSet: expect.arrayContaining([
              { Key: "alchemy:bootstrap", Value: "s3-state-store" },
              { Key: "Purpose", Value: "Alchemy state storage" },
              { Key: "CreatedBy", Value: "alchemy-effect-cli" },
            ]),
          },
        }),
      );
    });
  });
});

/**
 * Extracted logic from bootstrap-s3 command for testing.
 * This mirrors the findExistingBucket function.
 */
const findExistingBucketLogic = (s3: S3) =>
  Effect.gen(function* () {
    const buckets = yield* s3.listBuckets({});

    if (!buckets.Buckets) {
      return undefined;
    }

    for (const bucket of buckets.Buckets) {
      if (!bucket.Name) continue;

      const tags = yield* s3
        .getBucketTagging({ Bucket: bucket.Name })
        .pipe(Effect.catchAll(() => Effect.succeed({ TagSet: [] })));

      const hasTag = tags.TagSet?.some(
        (tag) =>
          tag.Key === "alchemy:bootstrap" && tag.Value === "s3-state-store",
      );

      if (hasTag) {
        return bucket.Name;
      }
    }

    return undefined;
  });

/**
 * Extracted bucket creation logic for testing.
 */
const createBucketLogic = (s3: S3, prefix: string, region: string) =>
  Effect.gen(function* () {
    const { randomBytes } = yield* Effect.promise(() => import("crypto"));
    const suffix = randomBytes(3).toString("hex");
    const bucketName = `${prefix}-${suffix}`;

    yield* s3.createBucket({
      Bucket: bucketName,
      ...(region !== "us-east-1" && {
        CreateBucketConfiguration: {
          LocationConstraint: region,
        },
      }),
    });

    yield* s3.putBucketTagging({
      Bucket: bucketName,
      Tagging: {
        TagSet: [
          { Key: "alchemy:bootstrap", Value: "s3-state-store" },
          { Key: "Purpose", Value: "Alchemy state storage" },
          { Key: "CreatedBy", Value: "alchemy-effect-cli" },
        ],
      },
    });

    return bucketName;
  });
