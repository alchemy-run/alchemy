import { describe, expect, test } from "bun:test";
import { apply } from "../../src/apply";
import { createCloudflareApi } from "../../src/cloudflare/api";
import { Bucket } from "../../src/cloudflare/bucket";
import { destroy } from "../../src/destroy";
import { BRANCH_PREFIX } from "../util";

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

  test("create, update, and delete bucket", async () => {
    let bucketOutput;
    // Create a test bucket
    const bucket = new Bucket(testId, {
      name: testId,
      locationHint: "wnam", // West North America
    });

    try {
      // Apply to create the bucket
      bucketOutput = await apply(bucket);
      expect(bucketOutput.id).toEqual(testId);
      expect(bucketOutput.name).toEqual(testId);

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
      const updatedBucket = new Bucket(testId, {
        name: testId,
        allowPublicAccess: true,
      });

      const updateOutput = await apply(updatedBucket);
      expect(updateOutput.id).toEqual(testId);

      // Verify public access was enabled
      const publicAccessResponse = await api.get(
        `/accounts/${api.accountId}/r2/buckets/${testId}/domains/managed`,
      );
      const publicAccessData =
        (await publicAccessResponse.json()) as CloudflareResponse<PublicAccessInfo>;
      expect(publicAccessData.result.enabled).toEqual(true);
    } finally {
      // Always clean up, even if test assertions fail
      await destroy(bucket).catch((e) =>
        console.error("Error cleaning up bucket:", e),
      );

      // Verify bucket was deleted
      if (bucketOutput) {
        const api = await createCloudflareApi();
        const getDeletedResponse = await api.get(
          `/accounts/${api.accountId}/r2/buckets/${testId}`,
        );
        expect(getDeletedResponse.status).toEqual(404);
      }
    }
  });

  test("bucket with jurisdiction", async () => {
    const euBucketName = `${testId}-eu`;
    const euBucket = new Bucket(euBucketName, {
      name: euBucketName,
      jurisdiction: "eu",
    });

    try {
      // Create a bucket with EU jurisdiction
      const bucketOutput = await apply(euBucket);
      expect(bucketOutput.id).toEqual(euBucketName);
      expect(bucketOutput.jurisdiction).toEqual("eu");

      // Verify the jurisdiction setting
      const api = await createCloudflareApi();
      const headers = { "cf-r2-jurisdiction": "eu" };
      const getResponse = await api.get(
        `/accounts/${api.accountId}/r2/buckets/${euBucketName}`,
        { headers },
      );
      expect(getResponse.status).toEqual(200);
    } finally {
      // Clean up
      await destroy(euBucket).catch((e) =>
        console.error("Error cleaning up EU bucket:", e),
      );
    }
  });
});
