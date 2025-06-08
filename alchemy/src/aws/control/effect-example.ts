/**
 * Example usage of the Effect-based CloudControl client
 * 
 * This demonstrates how to migrate from async/await patterns to Effect
 */

import { Effect, Console, Exit } from "effect";
import {
  createResource,
  getResource,
  updateResource,
  deleteResource,
  runWithCloudControl,
  makeCloudControlConfig,
  type CloudControlOptions,
} from "./effect-client.ts";

/**
 * Example: Creating an S3 bucket using Effect
 */
const createS3BucketExample = Effect.gen(function* () {
  // Create an S3 bucket
  const createResult = yield* createResource("AWS::S3::Bucket", {
    BucketName: "my-effect-bucket",
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    },
  });

  yield* Console.log(`Bucket created: ${createResult.Identifier}`);

  // Get the bucket to verify it exists
  const bucket = yield* getResource("AWS::S3::Bucket", createResult.Identifier);
  yield* Console.log(`Bucket properties:`, bucket);

  // Update the bucket with versioning
  const updateResult = yield* updateResource(
    "AWS::S3::Bucket",
    createResult.Identifier,
    [
      {
        op: "add",
        path: "/VersioningConfiguration",
        value: { Status: "Enabled" },
      },
    ]
  );

  yield* Console.log(`Bucket updated: ${updateResult.Identifier}`);

  return createResult.Identifier;
});

/**
 * Example: Error handling with Effect
 */
const errorHandlingExample = Effect.gen(function* () {
  const result = yield* getResource("AWS::S3::Bucket", "non-existent-bucket").pipe(
    Effect.catchTag("ResourceNotFoundException", (error) =>
      Effect.gen(function* () {
        yield* Console.log("Bucket not found, creating a new one...");
        return yield* createResource("AWS::S3::Bucket", {
          BucketName: "fallback-bucket",
        });
      })
    ),
    Effect.catchTag("ThrottlingException", (error) =>
      Effect.gen(function* () {
        yield* Console.log("Rate limited, using fallback...");
        return undefined;
      })
    )
  );

  return result;
});

/**
 * Example: Composing multiple operations
 */
const composedOperationsExample = Effect.gen(function* () {
  // Create multiple buckets in parallel
  const bucketNames = ["bucket-1", "bucket-2", "bucket-3"];
  
  const createBuckets = bucketNames.map((name) =>
    createResource("AWS::S3::Bucket", { BucketName: name })
  );

  const buckets = yield* Effect.all(createBuckets, { concurrency: 2 });
  
  yield* Console.log(`Created ${buckets.length} buckets`);

  // Get all bucket properties in parallel
  const bucketProperties = yield* Effect.all(
    buckets.map((bucket) =>
      getResource("AWS::S3::Bucket", bucket.Identifier)
    ),
    { concurrency: 3 }
  );

  return { buckets, bucketProperties };
});

/**
 * Run examples with proper error handling
 */
export async function runExamples() {
  const config: CloudControlOptions = {
    region: "us-east-1",
    maxRetries: 5,
  };

  // Example 1: Basic bucket creation
  console.log("=== Running S3 Bucket Creation Example ===");
  const createResult = await Effect.runPromise(
    runWithCloudControl(createS3BucketExample, config)
  );

  // Example 2: Error handling
  console.log("=== Running Error Handling Example ===");
  const errorResult = await Effect.runPromise(
    runWithCloudControl(errorHandlingExample, config)
  );

  // Example 3: Composed operations
  console.log("=== Running Composed Operations Example ===");
  const composedResult = await Effect.runPromise(
    runWithCloudControl(composedOperationsExample, config)
  );

  console.log("All examples completed successfully!");
}

/**
 * Migration guide from async/await to Effect
 */

// BEFORE (async/await):
/*
async function createBucketOldWay() {
  try {
    const client = await createCloudControlClient();
    const result = await client.createResource("AWS::S3::Bucket", {
      BucketName: "my-bucket"
    });
    console.log("Created:", result.Identifier);
    return result;
  } catch (error) {
    if (error instanceof AlreadyExistsError) {
      console.log("Bucket already exists");
      return null;
    }
    throw error;
  }
}
*/

// AFTER (Effect):
const createBucketNewWay = Effect.gen(function* () {
  const result = yield* createResource("AWS::S3::Bucket", {
    BucketName: "my-bucket",
  });
  
  yield* Console.log(`Created: ${result.Identifier}`);
  return result;
}).pipe(
  Effect.catchTag("AlreadyExistsError", (error) =>
    Effect.gen(function* () {
      yield* Console.log("Bucket already exists");
      return null;
    })
  )
);

/**
 * Benefits of the Effect approach:
 * 
 * 1. **Type-safe error handling**: Errors are part of the type signature
 * 2. **Composable**: Effects can be easily combined and transformed
 * 3. **Built-in retry logic**: No need to implement custom retry mechanisms
 * 4. **Resource safety**: Automatic cleanup and proper resource management
 * 5. **Testability**: Effects are pure and easily testable
 * 6. **Concurrency**: Built-in support for parallel and concurrent operations
 */