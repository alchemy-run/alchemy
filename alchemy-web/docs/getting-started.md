# Getting Started with Alchemy

Alchemy is a TypeScript-native Infrastructure as Code (IaC) framework that allows you to define and manage cloud resources using pure TypeScript/JavaScript code. Unlike other IaC tools, Alchemy has zero dependencies and can run in any JavaScript environment.

## Installation

```bash
bun add alchemy
```

## Creating Your First Alchemy Project 

Create a new file called `alchemy.config.ts`:

```ts
import alchemy from "alchemy";

// Initialize Alchemy app
await using app = alchemy("my-app", {
  stage: process.env.STAGE ?? "dev",
  password: process.env.SECRET_PASSPHRASE
});

// Define resources here
```

## Core Concepts

### Resources

Resources are the core building blocks in Alchemy. Each resource is defined as an async function that handles create, update and delete operations:

```ts
import { Role } from "alchemy/aws";

const role = await Role("api-role", {
  roleName: "api-lambda-role",
  assumeRolePolicy: {
    Version: "2012-10-17",
    Statement: [{
      Effect: "Allow",
      Principal: { Service: "lambda.amazonaws.com" },
      Action: "sts:AssumeRole"
    }]
  }
});

// Access resource properties
console.log(role.roleName); // "api-lambda-role"
```

### Context

Resources have access to context through the `this` parameter which provides:

- Current phase (create/update/delete)
- Resource state
- Scope information
- Helper methods

```ts
export const MyResource = Resource(
  "my::Resource",
  async function(this: Context<MyResource>, id: string, props: MyResourceProps) {
    if (this.phase === "delete") {
      return this.destroy();
    }
    
    // Create/update logic
    return this({
      id,
      ...props
    });
  }
);
```

## Working with Secrets

Alchemy provides built-in secret management:

```ts
const apiKey = alchemy.secret(process.env.API_KEY);

await Worker("api", {
  bindings: {
    API_KEY: apiKey // Will be encrypted in state
  }
});
```

## Testing

Create test files ending in `.test.ts`:

```ts
import { alchemy } from "alchemy";
import "alchemy/test/bun";

const test = alchemy.test(import.meta);

test("create and update resource", async (scope) => {
  const resource = await MyResource("test", {
    name: "test-resource"
  });
  
  expect(resource.name).toEqual("test-resource");
  
  // Resource will be cleaned up automatically
});
```

## Deployment

Run your Alchemy configuration:

```bash
# Deploy
bun alchemy.config.ts

# Destroy
bun alchemy.config.ts --destroy
```

## Next Steps

- Review the [examples](https://github.com/alchemy/examples) for real-world usage
- Learn how to [create custom resources](https://github.com/alchemy/docs/custom-resources.md)
- Join the [Discord community](https://discord.gg/alchemy) for help