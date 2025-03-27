import { describe, expect } from "bun:test";
import { alchemy } from "../../src/alchemy";
import { createCloudflareApi } from "../../src/cloudflare/api";
import { R2Bucket } from "../../src/cloudflare/bucket";
import "../../src/test/bun";
import { BRANCH_PREFIX } from "../util";

const test = alchemy.test(import.meta);

/**
 * Type definitions for API responses
 */
interface CloudflareResponse<T> {
  result: T;
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  messages: string[];
}

interface BucketInfo {
  name: string;
  location?: string;
  creation_date: string;
}

interface PublicAccessInfo {
  enabled: boolean;
  bucketId: string;
  domain: string;
}

describe("R2 Bucket Resource", () => {
  // Use BRANCH_PREFIX for deterministic, non-colliding resource names
  // Bucket names must be lowercase, so transform the prefix
  const testId = `${BRANCH_PREFIX.toLowerCase()}-test-bucket`;

  test("create, update, and delete bucket", async (scope) => {
    // Create a test bucket
    let bucket: R2Bucket | undefined = undefined;

    try {
      bucket = await R2Bucket(testId, {
        name: testId,
        locationHint: "wnam", // West North America
      });
      expect(bucket.name).toEqual(testId);

      // Verify bucket was created by querying the API directly
      const api = await createCloudflareApi();
      const getResponse = await api.get(
        `/accounts/${api.accountId}/r2/buckets/${testId}`,
      );
      expect(getResponse.status).toEqual(200);

      const responseData =
        (await getResponse.json()) as CloudflareResponse<BucketInfo>;
      expect(responseData.result.name).toEqual(testId);

      // Update the bucket to enable public access
      bucket = await R2Bucket(testId, {
        name: testId,
        allowPublicAccess: true,
      });

      // Verify public access was enabled
      const publicAccessResponse = await api.get(
        `/accounts/${api.accountId}/r2/buckets/${testId}/domains/managed`,
      );
      const publicAccessData =
        (await publicAccessResponse.json()) as CloudflareResponse<PublicAccessInfo>;
      expect(publicAccessData.result.enabled).toEqual(true);
    } finally {
      await alchemy.destroy(scope);

      // Verify bucket was deleted
      if (bucket) {
        await assertBucketDeleted(bucket);
      }
    }
  });

  test("bucket with jurisdiction", async (scope) => {
    const euBucketName = `${testId}-eu`;
    const euBucket = await R2Bucket(euBucketName, {
      name: euBucketName,
      jurisdiction: "eu",
    });

    try {
      // Create a bucket with EU jurisdiction
      expect(euBucket.name).toEqual(euBucketName);
      expect(euBucket.jurisdiction).toEqual("eu");

      // Verify the jurisdiction setting
      const api = await createCloudflareApi();
      const headers = { "cf-r2-jurisdiction": "eu" };
      const getResponse = await api.get(
        `/accounts/${api.accountId}/r2/buckets/${euBucketName}`,
        { headers },
      );
      expect(getResponse.status).toEqual(200);
    } finally {
      await alchemy.destroy(scope);
      await assertBucketDeleted(euBucket);
    }
  });
});

async function assertBucketDeleted(bucket: R2Bucket) {
  const api = await createCloudflareApi();
  const getDeletedResponse = await api.get(
    `/accounts/${api.accountId}/r2/buckets/${bucket.name}`,
  );
  expect(getDeletedResponse.status).toEqual(404);
}
