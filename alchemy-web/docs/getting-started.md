# Getting Started with Alchemy

Alchemy is an Infrastructure-as-Code library for building cloud applications with simple, familiar TypeScript code.

You write and run an `alchemy.run.ts` script that creates your resources (e.g. `await Database()`, or `await StaticSite()`) and Alchemy keeps track of each resource's state to automatically create new resouces, update modified ones, or delete resources you no longer need.

This enables you to focus on what infrastructure configuration you want and not worry about how to get there.

> [!TIP]
> Read [What is Alchemy](./what-is-alchemy.md) to get an overview of Alchemy and how it's different than tradtional IaC

## Installation

Start by installing the Alchemy library using Bun (or your preferred package manager):

```bash
bun add alchemy
```

## Creating Your First Alchemy App

Create a file named `alchemy.run.ts` in your project directory and follow these steps:

> [!TIP]
> `alchemy.run.ts` is just a convention - you can run Alchemy in any script or JavaScript environment.

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

### Step 2: Instantiate a Resource

A Resource is just an async function that takes a unique id (`config.json`) and some properties.

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

This finalizes your application scope by ensuring any "orphaned" resources are deleted.

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

> [!TIP]
> If you're familiar with other IaC tools, this should feel similar to `terraform apply`, `pulumi up`, `cdk deploy` or `sst deploy`

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

State files help Alchemy determine whether to create, update, delete, or skip resources on subsequent runs. If you run the same script again without changes, you'll see no operations performed because the state hasn't changed.

> [!NOTE]
> Learn more about Alchemy state in [Concepts: State](./concepts/state.md)

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

2. Or simply run with the `--destroy` flag:

```bash
bun ./alchemy.run.ts --destroy
```

The output should look like:

```
Delete:  "my-first-app/dev/config.json"
Deleted: "my-first-app/dev/config.json"
```

After deletion, both the file and its state entry will be removed.

> [!TIP]
> Recall that `--destroy` is arbitrary. You're free to design your own CLI to fit your preferences and use-case
> ```ts
> const app = alchemy("my-first-app", {
>  // this could just as easily be --remove to match sst!
>  phase: process.argv.includes("--remove") ? "destroy" : "up",
> });
> ```

## Next Steps

Now that you've created your first Alchemy project, you might want to:

- [Deploy a ViteJS site to Cloudflare](./guides/cloudflare/vitejs)
- [Build your own Custom Resource](./guides/custom-resources.md)
