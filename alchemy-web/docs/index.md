# Getting Started with Alchemy

Alchemy is a TypeScript-native Infrastructure as Code (IaC) framework that allows you to model resources as simple, memoized async functions. Unlike other IaC tools, Alchemy is implemented in pure ESM-native TypeScript with zero dependencies, making it lightweight and embeddable in any JavaScript runtime.

## Installation

To get started with Alchemy, you need to install it using Bun:

```bash
# Install Alchemy
bun add alchemy
```

## Creating Your First Alchemy Project

To create a basic Alchemy project, follow these steps:

1. **Initialize Alchemy**: Start by creating an Alchemy app, which serves as the root scope for your resources.

   ```ts twoslash
   import alchemy from "alchemy";

   await using app = alchemy("my-app", {
     stage: process.env.STAGE ?? "dev",
     phase: process.argv.includes("--destroy") ? "destroy" : "up",
     password: process.env.SECRET_PASSPHRASE,
     quiet: process.argv.includes("--verbose") ? false : true,
   });
   ```

2. **Define a Resource**: Create a resource, such as an AWS IAM Role, using Alchemy's resource functions.

   ```ts twoslash
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

3. **Run Your Script**: Execute your script to create the resources.

   ```bash
   bun ./my-app.ts
   ```

## Core Concepts

### Resources

In Alchemy, resources are modeled as async functions that can be created, updated, or deleted based on their state. Each resource has a unique name and lifecycle handler.

```ts
// Example of creating a resource
import { Role } from "alchemy/aws";

const role = await Role("my-role", {
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

Alchemy uses a context to manage the lifecycle of resources. The context provides information about the current phase (create, update, delete) and allows you to manage resource state.

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

Alchemy provides a way to handle secrets securely using the `alchemy.secret()` function. Secrets are encrypted in the state files.

```ts
// Example of using alchemy.secret()
const apiKey = alchemy.secret("API_KEY");
```

## Testing

Alchemy uses Bun for testing resources. You can create dedicated test files for each resource type and run tests using the following commands:

```bash
# Run all tests
bun test

# Run tests in a specific file
bun test alchemy/test/stripe/price.test.ts

# Run a specific test in a specific file
bun test --test-name-pattern="create and update price" alchemy/test/stripe/price.test.ts
```

## Deployment

Deploying resources with Alchemy involves running your script with the appropriate phase. You can specify the phase as "up" for deployment or "destroy" for teardown.

```ts
await using app = alchemy("my-app", {
  phase: "up", // or "destroy" for teardown
  stage: "prod",
});
```

## Next Steps

To learn more about Alchemy and explore advanced use cases, consider the following:

- Explore the examples directory for real-world use cases.
- Read the README.md for a comprehensive overview of Alchemy's features.
- Dive into the source code to understand how resources are implemented and extend Alchemy with custom resources.

> [!TIP]
> Alchemy is designed to be flexible and extensible. Feel free to experiment with creating custom resources and integrating Alchemy into your existing workflows.