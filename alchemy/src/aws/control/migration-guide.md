# Migration Guide: Async/Await to Effect

This guide shows how to migrate AWS CloudControl resources from async/await patterns to Effect-based patterns.

## Key Benefits of Effect

1. **Type-Safe Error Handling**: Errors are part of the type signature
2. **Composable Operations**: Effects can be easily combined and transformed  
3. **Built-in Retry Logic**: No need for custom retry mechanisms
4. **Resource Safety**: Automatic cleanup and proper resource management
5. **Better Concurrency**: Built-in support for parallel operations

## Basic Migration Patterns

### Creating Resources

**Before (Async/Await):**
```typescript
import { createCloudControlClient } from "./client.ts";

async function createBucket(bucketName: string) {
  try {
    const client = await createCloudControlClient();
    const result = await client.createResource("AWS::S3::Bucket", {
      BucketName: bucketName
    });
    console.log(`Created: ${result.Identifier}`);
    return result;
  } catch (error) {
    if (error instanceof AlreadyExistsError) {
      console.log("Bucket already exists");
      return null;
    }
    throw error;
  }
}
```

**After (Effect):**
```typescript
import * as Effect from "effect/Effect";
import * as Console from "effect/Console";
import { createResource, runWithCloudControl } from "./effect-client.ts";

const createBucket = (bucketName: string) =>
  Effect.gen(function* () {
    const result = yield* createResource("AWS::S3::Bucket", {
      BucketName: bucketName,
    });
    
    yield* Console.log(`Created: ${result.Identifier}`);
    return result;
  }).pipe(
    Effect.catchTag("AlreadyExistsError", () =>
      Effect.gen(function* () {
        yield* Console.log("Bucket already exists");
        return null;
      })
    )
  );

// Usage:
const result = await Effect.runPromise(
  runWithCloudControl(createBucket("my-bucket"))
);
```

### Error Handling

**Before (Async/Await):**
```typescript
async function getBucketWithFallback(bucketName: string) {
  try {
    const client = await createCloudControlClient();
    return await client.getResource("AWS::S3::Bucket", bucketName);
  } catch (error) {
    if (error instanceof ResourceNotFoundException) {
      console.log("Bucket not found, creating fallback");
      return await client.createResource("AWS::S3::Bucket", {
        BucketName: "fallback-bucket"
      });
    }
    if (error instanceof ThrottlingException) {
      console.log("Rate limited, retrying...");
      await new Promise(resolve => setTimeout(resolve, 1000));
      return getBucketWithFallback(bucketName);
    }
    throw error;
  }
}
```

**After (Effect):**
```typescript
const getBucketWithFallback = (bucketName: string) =>
  getResource("AWS::S3::Bucket", bucketName).pipe(
    Effect.catchTag("ResourceNotFoundException", () =>
      Effect.gen(function* () {
        yield* Console.log("Bucket not found, creating fallback");
        return yield* createResource("AWS::S3::Bucket", {
          BucketName: "fallback-bucket",
        });
      })
    ),
    // ThrottlingException is automatically retried by the Effect client
    Effect.catchTag("ThrottlingException", () =>
      Effect.gen(function* () {
        yield* Console.log("Rate limited, automatic retry will occur");
        return undefined;
      })
    )
  );
```

### Parallel Operations

**Before (Async/Await):**
```typescript
async function createMultipleBuckets(bucketNames: string[]) {
  const client = await createCloudControlClient();
  const promises = bucketNames.map(name => 
    client.createResource("AWS::S3::Bucket", { BucketName: name })
      .catch(error => {
        console.error(`Failed to create ${name}:`, error);
        return null;
      })
  );
  
  return await Promise.all(promises);
}
```

**After (Effect):**
```typescript
const createMultipleBuckets = (bucketNames: string[]) => {
  const createBuckets = bucketNames.map(name =>
    createResource("AWS::S3::Bucket", { BucketName: name }).pipe(
      Effect.catchAll(error =>
        Effect.gen(function* () {
          yield* Console.error(`Failed to create ${name}:`, error);
          return null;
        })
      )
    )
  );
  
  return Effect.all(createBuckets, { concurrency: 3 });
};
```

### Complex Operations with Resource Cleanup

**Before (Async/Await):**
```typescript
async function createTemporaryInfrastructure() {
  const client = await createCloudControlClient();
  let bucket = null;
  let table = null;
  
  try {
    // Create bucket
    bucket = await client.createResource("AWS::S3::Bucket", {
      BucketName: "temp-bucket"
    });
    
    // Create table
    table = await client.createResource("AWS::DynamoDB::Table", {
      TableName: "temp-table",
      AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }],
      KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
      BillingMode: "PAY_PER_REQUEST"
    });
    
    // Do some work...
    await doSomeWork(bucket, table);
    
    return { bucket, table };
  } catch (error) {
    // Cleanup on error
    if (bucket) {
      try {
        await client.deleteResource("AWS::S3::Bucket", bucket.Identifier);
      } catch (cleanupError) {
        console.error("Failed to cleanup bucket:", cleanupError);
      }
    }
    if (table) {
      try {
        await client.deleteResource("AWS::DynamoDB::Table", table.Identifier);
      } catch (cleanupError) {
        console.error("Failed to cleanup table:", cleanupError);
      }
    }
    throw error;
  }
}
```

**After (Effect):**
```typescript
import * as Scope from "effect/Scope";

const createTemporaryInfrastructure = Effect.gen(function* () {
  // Create bucket with automatic cleanup
  const bucket = yield* createResource("AWS::S3::Bucket", {
    BucketName: "temp-bucket",
  }).pipe(
    Effect.acquireRelease(
      (bucket) => deleteResource("AWS::S3::Bucket", bucket.Identifier).pipe(
        Effect.catchAll(() => Effect.unit) // Ignore cleanup errors
      )
    )
  );
  
  // Create table with automatic cleanup  
  const table = yield* createResource("AWS::DynamoDB::Table", {
    TableName: "temp-table",
    AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }],
    KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
    BillingMode: "PAY_PER_REQUEST",
  }).pipe(
    Effect.acquireRelease(
      (table) => deleteResource("AWS::DynamoDB::Table", table.Identifier).pipe(
        Effect.catchAll(() => Effect.unit) // Ignore cleanup errors
      )
    )
  );
  
  // Do some work...
  yield* doSomeWork(bucket, table);
  
  return { bucket, table };
}).pipe(Effect.scoped); // Automatic cleanup when scope ends
```

## Migration Checklist

- [ ] Replace `createCloudControlClient()` with `runWithCloudControl()`
- [ ] Convert async functions to Effect generators using `Effect.gen`
- [ ] Replace try/catch with `Effect.catchTag` for specific errors
- [ ] Use `Effect.all()` for parallel operations instead of `Promise.all()`
- [ ] Replace manual retry logic with Effect's built-in retry schedules
- [ ] Use `Effect.acquireRelease` for resource cleanup patterns
- [ ] Replace console.log with `Console.log` for pure logging
- [ ] Use `Effect.runPromise()` at the application boundary

## Testing

Effect-based code is easier to test because effects are pure and composable:

```typescript
import { Effect } from "effect";

// Test the effect without running it
const testEffect = createBucket("test-bucket");

// Provide mock services for testing
const mockConfig = Layer.succeed(CloudControlConfig, {
  client: mockAwsClient,
  region: "us-east-1",
  initialPollingDelay: 100,
  maxPollingDelay: 1000,
  maxRetries: 1,
});

const result = await Effect.runPromise(
  testEffect.pipe(Effect.provide(mockConfig))
);
```

This approach makes testing more reliable and eliminates the need for complex mocking.