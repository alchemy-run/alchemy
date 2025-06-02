import { describe, expect } from "vitest";
import { alchemy } from "../../../src/alchemy.js";
import { createCloudControlClient } from "../../../src/aws/control/client.js";
import { CloudControlResource } from "../../../src/aws/control/resource.js";
import { destroy } from "../../../src/destroy.js";
import { BRANCH_PREFIX } from "../../util.js";
// must import this or else alchemy.test won't exist
import "../../../src/test/vitest.js";

const client = await createCloudControlClient();

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

describe("CloudControlResource", () => {
  const testId = `${BRANCH_PREFIX}-test-bucket`;

  test("create, update, and delete S3 bucket", async (scope) => {
    let resource: CloudControlResource | undefined;
    try {
      // Create a test S3 bucket
      resource = await CloudControlResource(testId, {
        typeName: "AWS::S3::Bucket",
        desiredState: {
          BucketName: testId,
          VersioningConfiguration: {
            Status: "Enabled",
          },
        },
      });

      expect(resource.id).toBeTruthy();
      expect(resource.typeName).toEqual("AWS::S3::Bucket");

      // Verify bucket was created by querying the API directly
      const getResponse = (await client.getResource(
        "AWS::S3::Bucket",
        resource.id,
      ))!;
      expect(getResponse.BucketName).toEqual(testId);
      expect(getResponse.VersioningConfiguration.Status).toEqual("Enabled");

      // Update the bucket configuration
      resource = await CloudControlResource(testId, {
        typeName: "AWS::S3::Bucket",
        desiredState: {
          BucketName: testId,
          VersioningConfiguration: {
            Status: "Suspended",
          },
        },
      });

      expect(resource.id).toBeTruthy();

      // Verify bucket was updated
      const getUpdatedResponse = (await client.getResource(
        "AWS::S3::Bucket",
        resource.id,
      ))!;
      expect(getUpdatedResponse.VersioningConfiguration.Status).toEqual(
        "Suspended",
      );
    } finally {
      // Always clean up, even if test assertions fail
      await destroy(scope);

      // Verify bucket was deleted
      expect(
        await client.getResource("AWS::S3::Bucket", resource?.id!),
      ).toBeUndefined();
    }
  });

  test("adopt existing resource with different ID", async (scope) => {
    const bucketName = `${testId}-adopt-test`;
    const firstId = `${testId}-first`;
    const secondId = `${testId}-second`;

    let firstResource: CloudControlResource | undefined;
    let secondResource: CloudControlResource | undefined;

    try {
      // Create first bucket
      firstResource = await CloudControlResource(firstId, {
        typeName: "AWS::S3::Bucket",
        desiredState: {
          BucketName: bucketName,
          VersioningConfiguration: {
            Status: "Enabled",
          },
        },
        adopt: true,
      });

      expect(firstResource.id).toBeTruthy();
      expect(firstResource.typeName).toEqual("AWS::S3::Bucket");

      // Verify first bucket was created
      const getFirstResponse = (await client.getResource(
        "AWS::S3::Bucket",
        firstResource.id,
      ))!;
      expect(getFirstResponse.BucketName).toEqual(bucketName);
      expect(getFirstResponse.VersioningConfiguration.Status).toEqual(
        "Enabled",
      );

      // Try to create second bucket with same name but different ID - should adopt the existing one
      secondResource = await CloudControlResource(secondId, {
        typeName: "AWS::S3::Bucket",
        desiredState: {
          BucketName: bucketName, // Same bucket name
          VersioningConfiguration: {
            Status: "Suspended", // Different config
          },
        },
        adopt: true, // Enable adoption
      });

      expect(secondResource.id).toBeTruthy();
      expect(secondResource.id).toEqual(firstResource.id); // Should have same underlying resource ID
      expect(secondResource.typeName).toEqual("AWS::S3::Bucket");

      // Verify the bucket was updated with new configuration
      const getSecondResponse = (await client.getResource(
        "AWS::S3::Bucket",
        secondResource.id,
      ))!;
      expect(getSecondResponse.BucketName).toEqual(bucketName);
      expect(getSecondResponse.VersioningConfiguration.Status).toEqual(
        "Suspended",
      );
    } catch (err) {
      console.log(err);
      throw err;
    } finally {
      // Clean up
      await destroy(scope);

      // Verify bucket was deleted
      expect(
        await client.getResource("AWS::S3::Bucket", firstResource?.id!),
      ).toBeUndefined();
    }
  });

  test("wildcard deletion handler", async (scope) => {
    const bucketIds = [`${testId}-1`, `${testId}-2`];
    const resources: CloudControlResource[] = [];

    try {
      // Create multiple test buckets
      for (const bucketId of bucketIds) {
        const resource = await CloudControlResource(bucketId, {
          typeName: "AWS::S3::Bucket",
          desiredState: {
            BucketName: bucketId,
          },
        });
        resources.push(resource);
      }

      // Verify buckets were created
      for (const resource of resources) {
        const getResponse = (await client.getResource(
          "AWS::S3::Bucket",
          resource.id,
        ))!;
        expect(getResponse.BucketName).toBeTruthy();
      }

      // Trigger wildcard deletion
      await destroy(scope);

      // Verify all buckets were deleted
      for (const resource of resources) {
        expect(
          await client.getResource("AWS::S3::Bucket", resource.id),
        ).toBeUndefined();
      }
    } catch (err) {
      console.log(err);
      throw err;
    } finally {
      // Clean up in case any test assertions failed
      await destroy(scope);
    }
  });
});
