# Alchemy: Lightweight TypeScript IaC Library

## Overview
Alchemy is a lightweight, embeddable, zero-dependency, TypeScript-native Infrastructure-as-Code (IaC) library. Unlike similar tools like Pulumi, Terraform, and CloudFormation, Alchemy is implemented in pure ESM-native TypeScript with zero dependencies. Resources in Alchemy are simple memoized async functions that can run in any JavaScript runtime, including the browser, serverless functions, and durable workflows.

## Pure TypeScript Functions
Alchemy uses pure async TypeScript functions instead of the domain-specific languages or configuration files used by other IaC tools. This approach means you can leverage the full power of TypeScript, including type safety, autocompletion, and standard language features.

Resources in Alchemy are defined, created, and managed using standard async JavaScript/TypeScript functions:

```typescript
const worker = await Worker("api", {
  path: "./src/worker.ts",
  bindings: {
    MY_BUCKET: bucket
  }
});
```

This syntax allows for native asynchronous programming without special wrappers or constructs. Since resources are just async functions, they can be easily composed, extended, and reused using standard JavaScript patterns.

## All Resources are Custom Resources
In Alchemy, all resources follow the same pattern and are essentially "custom" resources. Creating your own resource types is trivial, allowing for easy extension of the framework to support any API or service.

Here's what a custom resource looks like:

```typescript
interface MyResourceProps {
  // Define the properties your resource accepts
}

interface MyResource extends Resource<"my:Resource"> {
  // Define the properties your resource returns
}

const MyResource = Resource("my:Resource",
  async function(this: MyResource, id: string, props: MyResourceProps) {
    // Implement resource creation, update, and deletion logic here
  }
);
```

For more detailed guidance on implementing custom resources, see the [Writing Custom Resources tutorial](/docs/tutorials/writing-custom-resource).

## AI-Optimized Resources
Alchemy resources are designed with AI code generation in mind. The resource implementation pattern is consistent and follows conventions that make it easier for LLMs to generate correct code.

We've established specific patterns in our [.cursorrules](https://github.com/sam-goodwin/alchemy/blob/main/.cursorrules) that help AI assistants create robust resource implementations. These rules ensure that generated resources follow best practices and maintain consistency across the codebase.

The AI-optimized approach means you can use tools like Cursor, Claude, or GPT to quickly generate new resource types by providing API documentation, making it easier to extend Alchemy to work with any service.

See the [Writing Custom Resources tutorial](/docs/tutorials/writing-custom-resource) for more information on how to create resources that work well with AI code generation.

## Project Structure
The main entry point for an Alchemy project is typically an `alchemy.run.ts` file, which initializes the Alchemy app and defines resources. This file is where you bootstrap your infrastructure code.

```
my-project/
├── alchemy.run.ts
├── src/
│   └── ... (application code)
└── .alchemy/
    └── my-app/
        └── dev/
            ├── resource1.json
            ├── resource2.json
            └── ...
```

The `.alchemy/` folder contains the state management files for your infrastructure, organized by app name, stage, and resource ID.

## State Management
Alchemy uses a simple file-based state management system by default, storing state in the `.alchemy` folder. Each resource's state is stored in a separate JSON file, making it easy to inspect and understand the current state of your infrastructure.

```json
{
  "provider": "cloudflare::Worker",
  "data": {},
  "deps": [],
  "status": "updated",
  "output": {
    "id": "api",
    "name": "my-worker",
    "url": "https://my-worker.workers.dev",
    "createdAt": 1678901234567
  },
  "props": {
    "name": "my-worker",
    "entrypoint": "./src/index.ts",
    "bindings": {
      "KV_NAMESPACE": {
        "namespaceId": "abcdef123456",
        "title": "my-namespace"
      }
    }
  }
}
```

The state management system is pluggable, allowing you to implement custom state storage backends if needed. This flexibility enables you to store state in databases, cloud storage, or any other storage solution that fits your workflow.

## Resource Scoping
Resources in Alchemy are organized into scopes, which provide isolation and management boundaries. Scopes form a hierarchical tree structure, similar to a file system.

```typescript
await alchemy.run("dev", async (scope) => {
  const bucket = await R2Bucket("assets", {
    name: "my-dev-bucket"
  });
});
```

In this example, the R2Bucket resource is created within the "dev" scope. Scopes help organize resources and enable targeted operations, such as destroying all resources within a particular scope.

## Resource Lifecycle
Alchemy manages the complete lifecycle of resources, including creation, updates, and deletion. Resources can create other resources within their lifecycle handlers, forming recursive resource trees.

When you create a resource, Alchemy checks if it already exists in the state. If it doesn't exist, the resource is created. If it exists and the properties have changed, the resource is updated. If it exists but is no longer referenced in the code, it is scheduled for deletion.

This automatic lifecycle management ensures that your infrastructure stays in sync with your code without manual intervention.

## Scope Management
The `alchemy.run()` function is used to create and manage scopes. You can create nested scopes to organize resources logically and isolate them from each other.

```typescript
await alchemy.run("nested", async (scope) => {
  // Resources created here are part of the "nested" scope
});
```

You can also create and "enter" a nested scope synchronously using `alchemy.scope()`:

```typescript
await using scope = alchemy.scope("nested");
// Resources created after this are placed in the "nested" scope
```

## Resource Cleanup
Alchemy provides a `destroy()` function for cleaning up resources. You can destroy individual resources, entire scopes, or the entire application.

```typescript
import { destroy } from "alchemy";

// Destroy a single resource
await destroy(resource);

// Destroy a scope and all resources within it
await destroy(scope);

// Destroy the entire app
await using _ = alchemy({
  phase: "destroy",
  stage: "dev"
});
```

Alchemy automatically handles the order of resource deletion, ensuring that dependent resources are deleted before their dependencies.

## Secrets Management
Alchemy provides built-in support for managing secrets securely. Secrets are encrypted in the state files using a password you provide.

```typescript
const app = alchemy("my-app", {
  password: process.env.ALCHEMY_PASSWORD
});

// Create an encrypted secret
const apiKey = alchemy.secret(process.env.API_KEY);

// Use the secret in a resource
const worker = await Worker("api", {
  bindings: {
    API_KEY: apiKey
  }
});
```

When the state is saved, the secret is encrypted and appears as an object with an `@secret` property:

```json
{
  "props": {
    "bindings": {
      "API_KEY": {
        "@secret": "Tgz3e/WAscu4U1oanm5S4YXH..."
      }
    }
  }
}
```

## Testing Resources
Alchemy provides a testing framework that makes it easy to test your resources. Tests use isolated scopes to prevent interference with other tests or your production resources.

```typescript
const test = alchemy.test(import.meta);

test("create and update worker", async (scope) => {
  const worker = await Worker("api", {
    path: "./src/worker.ts"
  });
  
  expect(worker.id).toBeTruthy();
  
  // Test worker functionality
});
```

The `alchemy.test()` function creates a test scope based on the current file, ensuring that resources created during the test are isolated and can be cleaned up afterwards.

For more detailed information on testing resources, see the [Testing documentation](/docs/concepts/testing).