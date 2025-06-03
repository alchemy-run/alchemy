---
title: Getting Started with Alchemy
description: Quick start guide to using Alchemy, the TypeScript-native Infrastructure-as-Code library. Learn how to install, create resources, and manage their lifecycle.
---

# Getting Started with Alchemy

> [!TIP]
> Read [What is Alchemy](./what-is-alchemy.md) to get an overview of Alchemy and how it's different than tradtional IaC

## Installation

Start by installing the Alchemy library using Bun (or your preferred package manager):

::: code-group

```sh [bun]
bun add alchemy
```

```sh [npm]
npm add alchemy
```

```sh [pnpm]
pnpm add alchemy
```

```sh [yarn]
yarn add alchemy
```

:::

## Create Your First Alchemy App

Create a file named `alchemy.run.ts` in your project directory and follow these steps:

> [!TIP]
> `alchemy.run.ts` is just a convention - you can run Alchemy in any script or JavaScript environment.

### Step 1: Initialize the Alchemy Application Scope

```typescript
import alchemy from "alchemy";

// Initialize the Alchemy application scope
const app = await alchemy("my-first-app", {
  stage: "dev",
  phase: process.argv.includes("--destroy") ? "destroy" : "up",
});
```

> [!NOTE]
> Learn more about Alchemy scopes in [Concepts: Scope](./concepts/scope.md)

### Step 2: Instantiate a Resource

A Resource is just an async function that takes a unique id (e.g. `config`) and some properties.

```typescript
import { File } from "alchemy/fs";

// Create a file resource
const hello = await File("hello", {
  path: "./hello.txt",
  content: "hello world"
});

console.log(`Created file at: ${hello.path}`);
```

> [!NOTE]
> Learn more about Alchemy resources in [Concepts: Resource](./concepts/resource.md)

### Step 3: Finalize the Application

At the end of our script, call `finalize`.

```typescript
// Finalize the app to apply changes
await app.finalize();
```

This is necessary for deleting what are called "orphaned resources" (more on that below).

> [!NOTE]
> Learn more about finalization and destroying resources in [Concepts: Destroy](./concepts/destroy.md)

## Run the Script

Now we simply run the script. Alchemy is just pure TypeScript, so you can run it with any JS engine, e.g. `bun`:

```bash
bun ./alchemy.run.ts
```

You will see output similar to:

```
Create:  "my-first-app/dev/hello"
Created: "my-first-app/dev/hello"
```

This indicates that Alchemy has:
1. Identified that the resource needs to be created
2. Successfully created the resource

We now have a `./hello.txt` file in our project:
```
hello world
```

> [!TIP]
> If you're familiar with other IaC tools, this should feel similar to `terraform apply`, `pulumi up`, `cdk deploy` or `sst deploy`

## Understanding State

After running your app, Alchemy creates a `.alchemy` directory to store state:

```sh
.alchemy/
  my-first-app/         # app
    dev/                # stage
      hello.txt.json  # resource
```

State files help Alchemy determine whether to create, update, delete, or skip resources on subsequent runs.

If you run the same script again without changes, you'll see no operations performed because the state hasn't changed.

> [!NOTE]
> Learn more about Alchemy state in [Concepts: State](./concepts/state.md)

## Update our File

Let's now update our `alchemy.run.ts` script to change the content of the file:

```ts
const hello = await File("hello", {
  // path: "./hello.txt",
  path: "./hello-world.txt",
  // content: "hello world"
  content: "Hello, world!"
});
```

Now, when we re-run the script, we'll see:
```
Update:  "my-first-app/dev/hello"
Updated: "my-first-app/dev/hello"
```

And now the `hello.txt` file is gone and replaced with `hello-world.txt` with different content:
```
Hello, World
```

Notice how we didn't have to write any code to delete the old file?

In a nutshell, that's the point of Infrastructure-as-Code - we just write code that creates the state we want and Alchemy takes care of deciding what to create, update or delete and in what order.

## Destroy the Resource

Let's now comment out the `File` and run it again.

```typescript
// const hello = await File("hello", {
//   path: "./hello-world.txt",
//   content: "Hello, world!"
// });
```

> [!CAUTION]
> Now, before we run our script again, you need to first add a "naked" impot of `alchemy/fs` at the top of our `alchemy.run.ts` script.
> ```typescript
> import "alchemy/fs"
> ```
> If you forget this, you would get an error
> `Cannot destroy resource "my-first-app/dev/hello" type fs::File - no provider found. You may need to import the provider in your alchemy.run.ts.`
> 
> This is because IDEs usually remove unused imports. If you don't import the resource, the delete handler won't be registered which Alchemy needs to delete the resource.

The output should look like:

```
Delete:  "my-first-app/dev/hello"
Deleted: "my-first-app/dev/hello"
```

And the `hello-world.txt` file is now gone.

> [!NOTE]
> You can read more about how to destroy resoruces and stacks in [Concepts: Destroy](./concepts/destroy.md)

## Next Steps

This was a very simple example using the local file system. Now, you might want to do something more interesting like deploy some Cloudflare resources or build your own!

- [Deploy a ViteJS site to Cloudflare](./guides/cloudflare-vitejs)
- [Build your own Custom Resource](./guides/custom-resources.md)
