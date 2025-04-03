# Getting Started with Alchemy

Alchemy is an embeddable, zero-dependency, TypeScript-native Infrastructure-as-Code (IaC) library for modeling resources that are created, updated, and deleted automatically. Unlike similar tools like Pulumi, Terraform, and CloudFormation, Alchemy is implemented in pure ESM-native TypeScript code with zero dependencies.

## Installation

To get started with Alchemy, you need to install it using your preferred package manager. We recommend using Bun for its speed and efficiency.

```bash
# Install Alchemy
bun add alchemy
```

## Creating Your First Alchemy Project

To create a basic Alchemy project, follow these steps:

1. **Initialize the Alchemy App**: Start by creating an Alchemy app in your TypeScript file.

    ```ts
    import alchemy from "alchemy";

    await using app = alchemy("my-first-app", {
      stage: "dev",
      phase: "up",
    });
    ```

2. **Define a Resource**: Create a simple resource, such as an AWS IAM Role.

    ```ts
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

3. **Run Your Script**: Execute your script using Bun.

    ```bash
    bun ./my-first-app.ts
    ```

## Core Concepts

### Resources

In Alchemy, resources are modeled as memoized async functions that can be executed in any async environment. This allows for easy creation, updating, and deletion of resources.

```ts
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

Alchemy uses a context to manage the lifecycle of resources. The context provides information about the current phase (create, update, delete) and allows for managing resource state.

```ts
export const MyResource = Resource(
  "my::Resource",
  async function (this, id, props) {
    if (this.phase === "delete") {
      return this.destroy();
    }
    // Resource creation logic
  }
);
```

## Working with Secrets

Alchemy provides a simple way to handle secrets using the `alchemy.secret()` function. This ensures that sensitive information is encrypted in the state files.

```ts
const apiKey = alchemy.secret("API_KEY");

await Worker("my-worker", {
  bindings: {
    API_KEY: apiKey,
  },
});
```

## Testing

Testing in Alchemy is straightforward. You can create tests for your resources using Bun's testing framework.

```ts
import { describe, expect } from "bun:test";
import { alchemy } from "../../src/alchemy";
import { Worker } from "../../src/cloudflare/worker";

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

Deploying resources with Alchemy involves running your script with the appropriate phase. For example, to deploy resources, ensure the phase is set to "up".

```ts
await using app = alchemy("my-app", {
  phase: "up",
});
```

To destroy resources, set the phase to "destroy".

```ts
await using app = alchemy("my-app", {
  phase: "destroy",
});
```

## Next Steps

To learn more about Alchemy and explore advanced use cases, consider the following:

- Explore the [Alchemy documentation](https://alchemy.example.com/docs) for detailed guides and API references.
- Check out the [examples](https://alchemy.example.com/examples) to see Alchemy in action.
- Join the Alchemy community on [Discord](https://discord.gg/alchemy) to connect with other users and developers.

> [!CAUTION]
> Avoid the temptation to over explain or over describe. Focus on concise, simple, high-value snippets.

> [!TIP]
> Make sure the examples follow a natural progression from minimal examples to more complex use cases.