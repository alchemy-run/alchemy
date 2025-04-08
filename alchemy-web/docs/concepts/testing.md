---
order: 5
---

# Testing

Alchemy provides a robust testing framework that handles resource isolation, state management, and automatic cleanup. This allows you to write tests that create real resources without worrying about test interference or cleanup.

## The `alchemy.test` Helper

Alchemy extends Bun's testing framework with an `alchemy.test` helper that creates isolated scopes for each test:

```typescript
import { describe, expect } from "bun:test";
import { alchemy } from "alchemy";
import "alchemy/test/bun"; // Required to enable alchemy.test

// Create a test suite with an isolated state namespace
const test = alchemy.test(import.meta, {
  prefix: "my-test-prefix", // Prefix for resource names
  destroy: true             // Auto-destroy resources after tests
});

describe("My Resources", () => {
  test("should create and verify a resource", async (scope) => {
    // Resources created here are isolated to this test
    const resource = await Resource("test-resource", {
      name: "Test Resource",
      // ...other properties
    });

    // Verify the resource was created correctly
    expect(resource.id).toBeTruthy();
    expect(resource.name).toEqual("Test Resource");
    
    // No manual cleanup needed - handled automatically
  });
});
```

## Test Isolation

Each test gets its own scope with a unique namespace, ensuring:

1. Resources in one test don't conflict with other tests
2. State is isolated between tests
3. Tests can be run in parallel without interference

## Resource Cleanup

Alchemy tests automatically clean up resources:

```typescript
test("create and clean up resources", async (scope) => {
  // Create test resources
  const resource = await Resource("test-resource", { /* ... */ });
  
  // No explicit cleanup needed - happens automatically
});
```

For manual cleanup, you can use try/finally with the destroy function:

```typescript
test("with manual cleanup", async (scope) => {
  try {
    // Create test resources
    const resource = await Resource("test-resource", { /* ... */ });
    
    // Test operations that might fail
    await someOperationThatMightFail();
  } finally {
    // Always clean up resources
    await destroy(scope);
  }
});
```

## Testing Best Practices

### 1. Use Unique Test Resource Names

Use the `BRANCH_PREFIX` or a similar approach to ensure test resource names don't collide:

```typescript
const testId = `${BRANCH_PREFIX}-test-resource`;
const resource = await Resource(testId, { /* ... */ });
```

### 2. Test Complete Lifecycle

Test the full lifecycle of resources including create, update, and delete operations:

```typescript
test("resource lifecycle", async (scope) => {
  // Create
  let resource = await Resource("lifecycle", { name: "Initial" });
  expect(resource.name).toEqual("Initial");
  
  // Update
  resource = await Resource("lifecycle", { name: "Updated" });
  expect(resource.name).toEqual("Updated");
  
  // Delete happens automatically through scope cleanup
});
```

### 3. Verify External State

When testing resources that interact with external services, verify the state directly:

```typescript
test("verify external state", async (scope) => {
  // Create a resource
  const bucket = await R2Bucket("test-bucket", {
    name: "test-bucket-name"
  });
  
  // Verify through direct API calls
  const api = await createCloudflareApi();
  const response = await api.get(`/accounts/${api.accountId}/r2/buckets/${bucket.name}`);
  expect(response.status).toEqual(200);
  
  // After destroy, verify it was removed
  await destroy(scope);
  const checkResponse = await api.get(`/accounts/${api.accountId}/r2/buckets/${bucket.name}`);
  expect(checkResponse.status).toEqual(404);
});
```

### 4. Use Test Helpers for Common Operations

Create helper functions for common test operations:

```typescript
async function assertResourceExists(id: string) {
  const response = await api.get(`/resources/${id}`);
  expect(response.status).toEqual(200);
}

async function assertResourceDoesNotExist(id: string) {
  const response = await api.get(`/resources/${id}`);
  expect(response.status).toEqual(404);
}
```

## Testing Options

The `alchemy.test` function accepts several options:

```typescript
const test = alchemy.test(import.meta, {
  // Auto-destroy resources after tests
  destroy: true,
  
  // Prefix for resource names to avoid conflicts
  prefix: "my-test",
  
  // Password for encrypting secrets in tests
  password: "test-password",
  
  // Custom state store for tests
  stateStore: (scope) => new InMemoryStateStore(scope),
  
  // Suppress logging during tests
  quiet: true
});
```

## Conditional Tests

You can conditionally skip tests:

```typescript
// Skip test if condition is true
test.skipIf(process.env.CI === "true")("skip in CI", async (scope) => {
  // This test will be skipped in CI environments
});
```

## Setup and Teardown

Use Bun's `beforeAll` and `afterAll` functions with Alchemy contexts:

```typescript
test.beforeAll(async (scope) => {
  // Setup shared resources for all tests
  const sharedResource = await Resource("shared", { /* ... */ });
});

test.afterAll(async (scope) => {
  // Clean up any shared resources
  await destroy(scope);
});
```

## Test in CI

When running tests in CI environments, you can use remote state storage to ensure proper state tracking:

```typescript
// In your test setup
const test = alchemy.test(import.meta, {
  stateStore: process.env.CI 
    ? (scope) => new R2RestStateStore(scope, {
        apiKey: alchemy.secret(process.env.CLOUDFLARE_API_KEY),
        email: process.env.CLOUDFLARE_EMAIL,
        bucketName: process.env.CLOUDFLARE_BUCKET_NAME!,
      })
    : undefined // Use default file system store in development
});
```

## Related Concepts

- [Resource Scopes](./scope.md#test-scope) - How test scopes isolate resources during testing
- [State Management](./state.md) - How resource state is tracked
- [Resource Destruction](./destroy.md) - How resources are cleaned up 