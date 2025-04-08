# Getting Started with Alchemy

Alchemy is a TypeScript-native Infrastructure-as-Code (IaC) library with zero dependencies. It lets you model resources that are automatically created, updated, and deleted.

## Installation

Start by installing Alchemy using Bun:

```bash
bun add alchemy
```

## Creating Your First Alchemy App

Create a file named `alchemy.run.ts` in your project directory and follow these steps:

### Step 1: Initialize the Alchemy Application Scope

```typescript
import alchemy from "alchemy";
import { File } from "alchemy/fs";

// Initialize the Alchemy application scope
const app = alchemy("my-first-app", {
  stage: "dev",
  phase: process.argv.includes("--destroy") ? "destroy" : "up",
  quiet: false,
});
```

> [!NOTE]
> Learn more about Alchemy scopes in [Concepts: Scope](./concepts/scope.md)

### Step 2: Create Resources

```typescript
// Create a file resource
const configFile = await File("config.json", {
  path: "./config.json",
  content: "hello world"
});

console.log(`Created file at: ${configFile.path}`);
```

> [!NOTE]
> Learn more about Alchemy resources in [Concepts: Resource](./concepts/resource.md)

### Step 3: Finalize the Application

```typescript
// Finalize the app to apply changes
await app.finalize();
```

This finalizes your application scope, ensuring all resources are properly created, updated, or deleted.

## Running Your App

Run your Alchemy app with:

```bash
bun ./alchemy.run.ts
```

You should see output similar to:

```
Create:  "my-first-app/dev/config.json"
Created: "my-first-app/dev/config.json"
```

This indicates that Alchemy has:
1. Identified that the resource needs to be created
2. Successfully created the resource

## Understanding State

After running your app, Alchemy creates a `.alchemy` directory to store state:

```
.alchemy/
  my-first-app/
    dev/
      config.json.json
```

This state file tracks:
- Resource properties
- Output values
- Current status
- Dependencies

> [!NOTE]
> Learn more about Alchemy state in [Concepts: State](./concepts/state.md)

State files help Alchemy determine whether to create, update, delete, or skip resources on subsequent runs. If you run the same script again without changes, you'll see no operations performed because the state hasn't changed.

## Destroying Resources

To delete resources, either:

1. Comment out the resource and run again:

```typescript
// COMMENTED OUT:
// const configFile = await File("config.json", {
//   path: "./config.json",
//   content: "hello world"
// });
```

2. Or run with the `--destroy` flag:

```bash
bun ./alchemy.run.ts --destroy
```

The output should look like:

```
Delete:  "my-first-app/dev/config.json"
Deleted: "my-first-app/dev/config.json"
```

After deletion, both the file and its state entry will be removed.

> [!NOTE]
> Learn more about resource lifecycle in [Concepts: Destroy](./concepts/destroy.md) and [Scope Finalization](./concepts/scope.md#scope-finalization).

## Next Steps

Now that you've created your first Alchemy project, you might want to:

- Try a more complex example with [Cloudflare and Vite](./guides/cloudflare/vitejs)
- Learn about [Resource Scopes](./concepts/scope.md)
- Understand [Secrets Management](./concepts/secret.md)
- Learn about [Testing Your Infrastructure](./concepts/testing.md)

Alchemy's modular, zero-dependency approach makes it perfect for embedding in any JavaScript environment, from browsers to serverless functions.
