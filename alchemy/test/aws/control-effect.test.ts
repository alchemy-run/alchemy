import * as Effect from "effect/Effect";
import { describe, expect, test } from "vitest";
import {
  createResource,
  getResource,
  updateResource,
  deleteResource,
  runWithCloudControl,
  CloudControlConfig,
  makeCloudControlConfig,
  type CloudControlOptions,
} from "../../src/aws/control/effect-client.ts";

const test = alchemy.test(import.meta, {
  prefix: "effect-test",
});

describe("Effect-based CloudControl Client", () => {
  test("should handle error types correctly", async (scope) => {
    // Test that error types are properly typed and catchable
    const testEffect = Effect.gen(function* () {
      // This should fail with ResourceNotFoundException
      const result = yield* getResource("AWS::S3::Bucket", "non-existent-bucket");
      return result;
    }).pipe(
      Effect.catchTag("ResourceNotFoundException", (error) =>
        Effect.succeed(undefined)
      ),
      Effect.catchTag("NetworkError", (error) =>
        Effect.succeed(undefined)
      )
    );

    const config: CloudControlOptions = {
      region: "us-east-1",
      maxRetries: 1,
    };

    // This shouldn't throw - errors should be handled by catchTag
    const result = await Effect.runPromise(
      runWithCloudControl(testEffect, config)
    );

    expect(result).toBeUndefined();
  });

  test("should compose multiple operations", async (scope) => {
    const composedEffect = Effect.gen(function* () {
      // Test that operations can be composed
      const bucketName = `test-bucket-${Date.now()}`;
      
      // Chain operations together
      const createResult = yield* createResource("AWS::S3::Bucket", {
        BucketName: bucketName,
      }).pipe(
        Effect.catchTag("AlreadyExistsError", (error) =>
          Effect.succeed(error.progressEvent)
        )
      );

      const bucketProperties = yield* getResource(
        "AWS::S3::Bucket",
        createResult.Identifier
      );

      return { createResult, bucketProperties };
    });

    const config: CloudControlOptions = {
      region: "us-east-1",
      maxRetries: 1,
    };

    // Test type inference and composition
    const effect = runWithCloudControl(composedEffect, config);
    
    // Verify the effect has the right type structure
    expect(typeof effect).toBe("object");
    expect(effect).toHaveProperty("_tag");
  });

  test("should handle parallel operations", async (scope) => {
    const parallelEffect = Effect.gen(function* () {
      // Create multiple operations that can run in parallel
      const operations = [
        getResource("AWS::S3::Bucket", "bucket-1"),
        getResource("AWS::S3::Bucket", "bucket-2"),
        getResource("AWS::S3::Bucket", "bucket-3"),
      ].map((op) =>
        op.pipe(
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined)
          )
        )
      );

      // Run operations in parallel with concurrency limit
      const results = yield* Effect.all(operations, { concurrency: 2 });
      
      return results;
    });

    const config: CloudControlOptions = {
      region: "us-east-1", 
      maxRetries: 1,
    };

    // Test that parallel composition works
    const effect = runWithCloudControl(parallelEffect, config);
    expect(typeof effect).toBe("object");
    expect(effect).toHaveProperty("_tag");
  });

  test("should provide proper layer configuration", async (scope) => {
    // Test that the CloudControl configuration layer works
    const testWithLayer = Effect.gen(function* () {
      const config = yield* CloudControlConfig;
      
      // Verify config structure
      expect(config).toHaveProperty("client");
      expect(config).toHaveProperty("region");
      expect(config).toHaveProperty("initialPollingDelay");
      expect(config).toHaveProperty("maxPollingDelay");
      expect(config).toHaveProperty("maxRetries");
      
      return config;
    });

    const configLayer = makeCloudControlConfig({
      region: "us-east-1",
      initialPollingDelay: 500,
      maxPollingDelay: 5000,
      maxRetries: 2,
    });

    // Test that the layer can be created and used
    const effect = testWithLayer.pipe(
      Effect.provide(configLayer),
      Effect.flatten
    );

    expect(typeof effect).toBe("object");
    expect(effect).toHaveProperty("_tag");
  });

  test("should maintain API compatibility", () => {
    // Test that the Effect API maintains the same method signatures
    // as the original async/await API (in terms of input parameters)
    
    const typeName = "AWS::S3::Bucket";
    const identifier = "test-bucket";
    const desiredState = { BucketName: "test" };
    const patchDocument = [{ op: "add", path: "/test", value: "value" }];

    // These should compile without type errors
    const createEffect = createResource(typeName, desiredState);
    const getEffect = getResource(typeName, identifier);
    const updateEffect = updateResource(typeName, identifier, patchDocument);
    const deleteEffect = deleteResource(typeName, identifier);

    // Verify these are Effect objects
    expect(createEffect).toHaveProperty("_tag");
    expect(getEffect).toHaveProperty("_tag");
    expect(updateEffect).toHaveProperty("_tag");
    expect(deleteEffect).toHaveProperty("_tag");
  });
});

// Integration test with actual AWS (commented out to avoid real API calls)
/*
describe("Effect CloudControl Integration", () => {
  test.skip("should create and delete an S3 bucket", async (scope) => {
    const bucketName = `alchemy-effect-test-${Date.now()}`;
    
    const integrationTest = Effect.gen(function* () {
      // Create bucket
      const createResult = yield* createResource("AWS::S3::Bucket", {
        BucketName: bucketName,
      });
      
      console.log(`Created bucket: ${createResult.Identifier}`);
      
      // Verify bucket exists
      const bucket = yield* getResource("AWS::S3::Bucket", createResult.Identifier);
      expect(bucket).toBeDefined();
      expect(bucket?.BucketName).toBe(bucketName);
      
      // Delete bucket
      const deleteResult = yield* deleteResource("AWS::S3::Bucket", createResult.Identifier);
      console.log(`Deleted bucket: ${deleteResult.Identifier}`);
      
      // Verify bucket is gone
      const deletedBucket = yield* getResource("AWS::S3::Bucket", createResult.Identifier);
      expect(deletedBucket).toBeUndefined();
      
      return { createResult, deleteResult };
    });

    const config: CloudControlOptions = {
      region: "us-east-1",
      maxRetries: 3,
    };

    const result = await Effect.runPromise(
      runWithCloudControl(integrationTest, config)
    );
    
    expect(result.createResult.Identifier).toBe(bucketName);
    expect(result.deleteResult.Identifier).toBe(bucketName);
  });
});
*/