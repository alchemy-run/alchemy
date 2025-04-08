# Testing in Alchemy

Alchemy provides a robust testing framework that simplifies resource testing by managing test scopes and resource lifecycle. Testing resources ensures they behave correctly during creation, updates, and deletion.

## Understanding Test Scopes

Alchemy tests use isolated scopes to prevent test resources from interfering with each other or your production resources. Each test creates its own scope with a unique state folder structure.

> [!NOTE]
> Test scopes are automatically created based on the test file name, ensuring isolation between different test suites.

## Setting up Tests

To begin testing Alchemy resources, import the test utilities and set up a test file:

```typescript
import { describe, expect } from "bun:test";
import { alchemy } from "../../src/alchemy";
import { destroy } from "../../src/destroy";
import { MyResource } from "../../src/my-service/my-resource";
// Import test utilities
import "../../src/test/bun";

// Create a test helper with the current module's scope
const test = alchemy.test(import.meta);

describe("MyResource", () => {
  test("create and update resource", async (scope) => {
    // Test implementation
  });
});
```

## Test Scope

The `alchemy.test(import.meta)` function creates a test scope based on the current file. This creates a corresponding folder structure in the `.alchemy/` directory:

```
.alchemy/
  test/
    my-resource.test/
      test-resource-name.json
```

> [!TIP]
> Each test gets its own scope, preventing resource conflicts between tests and making cleanup easier.

## Writing Test Cases

A basic test case follows this structure:

```typescript
test("resource lifecycle", async (scope) => {
  try {
    // Create the resource
    const resource = await MyResource("test-resource", {
      name: "test-resource",
      property: "value"
    });
    
    // Test resource properties
    expect(resource.id).toBeTruthy();
    
    // Update the resource
    const updated = await MyResource("test-resource", {
      name: "test-resource",
      property: "updated-value"
    });
    
    // Test updated properties
    expect(updated.property).toEqual("updated-value");
  } finally {
    // Clean up resources
    await destroy(scope);
  }
});
```

## Test Configuration

Alchemy tests can be configured with several options:

```typescript
test("custom test configuration", 
  {
    destroy: true,     // Auto-destroy resources after test
    quiet: false,      // Show detailed logs
    password: "test",  // Password for secrets encryption
    stateStore: customStore // Custom state storage
  }, 
  async (scope) => {
    // Test implementation
  }
);
```

## Resource Lifecycle Testing

A comprehensive test should verify the entire resource lifecycle:

```typescript
test("full lifecycle", async (scope) => {
  // Create resource
  const resource = await MyResource("test", { 
    name: "test-resource" 
  });
  expect(resource.id).toBeTruthy();
  
  // Verify resource was created (using direct API calls)
  const exists = await checkResourceExists(resource.id);
  expect(exists).toBe(true);
  
  // Update resource
  const updated = await MyResource("test", { 
    name: "updated-name" 
  });
  expect(updated.name).toEqual("updated-name");
  
  // Delete and verify deletion
  await destroy(scope);
  const stillExists = await checkResourceExists(resource.id);
  expect(stillExists).toBe(false);
});
```

## Working with Test Scopes

Test scopes isolate resources to prevent conflicts:

```typescript
// Global setup for all tests in this file
test.beforeAll(async (scope) => {
  // Create shared resources
});

// Test-specific resources
test("isolated test", async (scope) => {
  // Resources created here are isolated to this test
});

// Global cleanup
test.afterAll(async (scope) => {
  // Clean up shared resources
});
```

## Cleanup and Error Handling

Always ensure proper cleanup, even when tests fail:

```typescript
test("with error handling", async (scope) => {
  try {
    const resource = await MyResource("test", {
      name: "test-resource"
    });
    
    // Test assertions
    expect(resource).toBeDefined();
    
    // Intentionally throw an error
    if (someCondition) {
      throw new Error("Test failure");
    }
  } catch (error) {
    console.error("Test failed:", error);
    throw error; // Re-throw to fail the test
  } finally {
    // Always clean up, even if test fails
    await destroy(scope);
  }
});
```

> [!TIP]
> The `destroy()` function is idempotent and safe to call multiple times, making it perfect for cleanup in the `finally` block.