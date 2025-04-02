# Getting Started with Alchemy

Alchemy is a TypeScript-native Infrastructure as Code (IaC) framework that allows you to model resources as simple, memoized async functions. Unlike other IaC tools, Alchemy is implemented in pure ESM-native TypeScript with zero dependencies, making it lightweight and embeddable in any JavaScript runtime.

## Installation

To get started with Alchemy, you need to install it using Bun:

```bash
# Install Alchemy
bun add alchemy
```

## Creating Your First Alchemy Project

Let's create a basic Alchemy project to understand how it works. Start by creating a new TypeScript file, say `alchemy.config.ts`, and set up your Alchemy app:

```ts
import alchemy from "alchemy";

// Initialize the Alchemy app
await using app = alchemy("my-first-app", {
  stage: process.env.STAGE ?? "dev",
  phase: process.argv.includes("--destroy") ? "destroy" : "up",
  password: process.env.SECRET_PASSPHRASE,
  quiet: process.argv.includes("--verbose") ? false : true,
});

// Define a simple resource
import { Role } from "alchemy/aws";

export const role = await Role("my-role", {
  roleName: "my-role",
  assumeRolePolicy: {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Service: "lambda.amazonaws.com" },
        Action: "sts:AssumeRole",
      },
    ],
  },
});

console.log({
  roleName: role.roleName,
});
```

## Core Concepts

### Resources

In Alchemy, resources are modeled as async functions that can be created, updated, or deleted. Each resource is defined with a unique name and a lifecycle handler that manages its state.

```ts
// Example of creating a resource
import { Role } from "alchemy/aws";

export const role = await Role("my-role", {
  roleName: "my-role",
  assumeRolePolicy: {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Service: "lambda.amazonaws.com" },
        Action: "sts:AssumeRole",
      },
    ],
  },
});
```

### Context

The context in Alchemy provides information about the resource's lifecycle, such as its phase (create, update, delete) and current state. It is accessed using the `this` keyword within the resource function.

```ts
// Example of working with context
export const MyResource = Resource(
  "my::Resource",
  async function (this, id, props) {
    if (this.phase === "delete") {
      return this.destroy();
    }
    // Resource creation or update logic
    return this(props);
  }
);
```

## Working with Secrets

Alchemy provides a way to handle secrets securely using the `alchemy.secret()` function. Secrets are encrypted in the state files using a password provided during app initialization.

```ts
// Example of using alchemy.secret()
const apiKey = alchemy.secret(process.env.API_KEY);

await Worker("my-worker", {
  bindings: {
    API_KEY: apiKey,
  },
});
```

## Testing

Testing in Alchemy is done using Bun. You can create dedicated test files for each resource type and run them using the Bun test runner.

```ts
// Example of testing Alchemy resources
import { describe, expect } from "bun:test";
import { alchemy } from "../../src/alchemy";
import { Worker } from "../../src/cloudflare/worker";

const test = alchemy.test(import.meta);

describe("Worker Resource", () => {
  test("create and delete worker", async (scope) => {
    const worker = await Worker("test-worker", {
      name: "test-worker",
      script: "console.log('Hello, world!');",
    });

    expect(worker.id).toBeTruthy();
    await alchemy.destroy(scope);
  });
});
```

## Deployment

Deploying resources with Alchemy involves running your script with the appropriate phase. You can deploy resources by setting the phase to "up" and destroy them by setting it to "destroy".

```ts
// Example of deployment
await using app = alchemy("my-app", {
  phase: "up", // or "destroy" to remove resources
});
```

## Next Steps

To learn more about Alchemy, explore the following resources:

- [Alchemy Documentation](https://github.com/your-repo/alchemy)
- [Examples](https://github.com/your-repo/alchemy/examples)
- [API Reference](https://github.com/your-repo/alchemy/api)

> [!CAUTION]
> Avoid the temptation to over explain or over describe. Focus on concise, simple, high-value snippets.

> [!TIP]
> Make sure the examples follow a natural progression from minimal examples to more complex use cases.