---
order: 0
---

# Custom Resource

Generate complete Alchemy resources by sharing a simple prompt with an AI assistant that has access to the [.cursorrules](https://github.com/sam-goodwin/alchemy/blob/main/.cursorrules) file.

## Simple Prompt Example

> Create a Resource for managing a Neon Database
> See: https://api-docs.neon.tech/reference/createprojectbranchdatabase

That's it! With this prompt, the AI will generate everything you need.

## Generated Code Structure

### 1. Import Statements

```typescript
import type { Context } from "../context";
import { Resource } from "../resource";
```

### 2. Props Interface

The properties needed to create or update the resource:

```typescript
export interface DatabaseProps {
  name: string;
  branchId: string;
  projectId: string;
  // Other properties...
}
```

### 3. Resource Interface

The resource interface extends the props and adds resource-specific fields:

```typescript
export interface Database extends Resource<"neon::Database">, DatabaseProps {
  id: string;
  createdAt: number;
  // Additional properties...
}
```

### 4. Resource Implementation

The implementation handles create, update, and delete operations:

```typescript
export const Database = Resource(
  "neon::Database",
  async function(this: Context<Database>, id: string, props: DatabaseProps): Promise<Database> {
    // Initialize API client
    const api = new NeonApi();

    if (this.phase === "delete") {
      // Delete resource logic
      // ...
      return this.destroy();
    } else if (this.phase === "update") {
      // Update resource logic
      // ...
      return this({/* updated resource */});
    } else {
      // Create resource logic
      // ...
      return this({/* new resource */});
    }
  }
);
```

### 5. Test File Setup

Basic imports and test configuration:

```typescript
import { describe, expect } from "bun:test";
import { alchemy } from "../../src/alchemy";
import { destroy } from "../../src/destroy";
import { Database } from "../../src/neon/database";
import { BRANCH_PREFIX } from "../util";
import "../../src/test/bun";
```

### 6. Test Scope Creation

Create a test scope using the current file:

```typescript
// Create test scope using filename
const test = alchemy.test(import.meta);
```

### 7. Test Description and Variables

Set up test identifiers:

```typescript
describe("Database Resource", () => {
  const testId = `${BRANCH_PREFIX}-test-database`;
```

### 8. Resource Test Implementation

Test creating, updating, and deleting the resource:

```typescript
  test("create, update, and delete database", async (scope) => {
    let database;
    try {
      // Create resource
      database = await Database(testId, {
        name: `${testId}-db`,
        // Other required properties...
      });
      
      // Test assertions
      expect(database.id).toBeTruthy();
      
      // Update resource
      database = await Database(testId, {
        // Updated properties...
      });
      
      // More test assertions
    } finally {
      // Clean up resources
      await destroy(scope);
      
      // Verify resource was deleted
    }
  });
});
```

## Related

- [Resource Scopes](../concepts/scope.md)
- [Testing in Alchemy](../concepts/testing.md)
- [Resource Implementation](../concepts/resource.md) 