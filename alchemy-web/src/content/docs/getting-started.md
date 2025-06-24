---
title: Getting Started with Alchemy
description: Quick start guide to using Alchemy, the TypeScript-native Infrastructure-as-Code library. Deploy your first Cloudflare Worker with type-safe infrastructure code.
---

# Getting Started

This guide will deploy a Cloudflare Worker and bind resources to it with Alchemy.

> [!TIP]
> Read [What is Alchemy](./what-is-alchemy.md) to get an overview of Alchemy and how it's different than traditional IaC

## Prerequisites

- [Node](https://nodejs.org/en), [Bun](https://bun.sh/) or [Deno](https://deno.com/)
- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier works)

## Initialize Project

::: code-group

```sh [bun]
mkdir my-alchemy-app
cd my-alchemy-app
bun init -y
```

```sh [npm]
mkdir my-alchemy-app
cd my-alchemy-app
npm init -y
npm install -D typescript @types/node tsx
```

```sh [pnpm]
mkdir my-alchemy-app
cd my-alchemy-app
pnpm init
pnpm add -D typescript @types/node tsx
```

```sh [yarn]
mkdir my-alchemy-app
cd my-alchemy-app
yarn init -y
yarn add -D typescript @types/node tsx
```

:::

## Install Dependencies

::: code-group

```sh [bun]
bun add alchemy
bun add -g wrangler
```

```sh [npm]
npm install alchemy
npm install -g wrangler
```

```sh [pnpm]
pnpm add alchemy
pnpm add -g wrangler
```

```sh [yarn]
yarn add alchemy
yarn global add wrangler
```

:::

## Login to Cloudflare

```sh
wrangler login
```

This will open your browser to authenticate with your Cloudflare account.

> [!TIP]
> Alchemy automatically uses your wrangler OAuth token. See the [Cloudflare Auth](./guides/cloudflare-auth.md) guide for alternative authentication methods.

## Create `alchemy.run.ts`

```sh
my-project/
└── alchemy.run.ts
```

In `alchemy.run.ts`, import `alchemy` and initialize the application:

```typescript
import alchemy from "alchemy";
import { Worker } from "alchemy/cloudflare";

const app = await alchemy("my-first-app");
```

Deploy a Cloudflare [`Worker`](./providers/cloudflare/worker.md):

```typescript
const worker = await Worker("hello-worker", {
  // reference the worker script (we will create that next)
  entrypoint: "./src/worker.ts",
});
```

Print out its URL:

```ts
// log out its URL
console.log(`Worker deployed at: ${worker.url}`);
```

Finally, make sure to call `app.finalize()` at the very end to delete resources that are no longer needed:

```typescript
// Finalize the app to apply changes
await app.finalize();
```

## Create Worker Entrypoint

The `Worker` resource we created before will try to bundle `entrypoint: "./src/worker.ts"`.

```sh
my-project/
├── src/
│   └── worker.ts
└── alchemy.run.ts
```

Let's create this script and implement our HTTP server:

```typescript
export default {
  async fetch(request: Request): Promise<Response> {
    return Response.json({
      message: "Hello from Alchemy!",
      timestamp: new Date().toISOString(),
    });
  },
};
```

## Deploy the Worker

Simply run your `alchemy.run.ts` script to deploy this Worker to Cloudflare:

::: code-group

```sh [bun]
bun ./alchemy.run.ts
```

```sh [npm]
npx tsx ./alchemy.run.ts
```

```sh [pnpm]
pnpm tsx ./alchemy.run.ts
```

```sh [yarn]
yarn tsx ./alchemy.run.ts
```

:::

You will see output similar to:

```
Create:  "my-first-app/dev/hello-worker"
Created: "my-first-app/dev/hello-worker"
Worker deployed at: https://hello-worker.your-subdomain.workers.dev
```

Visit the URL to see your worker in action!

> [!TIP]
> If you're familiar with other IaC tools, this should feel similar to `terraform apply`, `pulumi up`, `cdk deploy` or `sst deploy`

## Add Bindings

Now let's add some infrastructure to our worker. We'll add a KV namespace for storage.

First, update your `alchemy.run.ts` to import the [`KVNamespace`](./providers/cloudflare/kv-namespace.md) Resource

```typescript
import { KVNamespace } from "alchemy/cloudflare";
```

Then, create a new `KVNamespace`:

```ts
const kv = await KVNamespace("my-app-storage");
```

And bind it to our `Worker` resource we created before:

```ts
const worker = await Worker("hello-worker", {
  entrypoint: "./src/worker.ts",
  bindings: {
    // bind the KV Namespace to the Worker
    KV: kv,
  },
});
```

> [!NOTE]
> Learn more in the [Cloudflare Bindings documentation](./concepts/bindings.md).

Finally, update your `./src/worker.ts` to use these bindings:

```typescript
// type-only import the worker from your `alchemy.run.ts`
import type { worker } from "../alchemy.run.ts";

export default {
  // use `typeof worker.Env` to infer the environment types from the bindings
  async fetch(request: Request, env: typeof worker.Env): Promise<Response> {
    // Store and retrieve data with type safety
    await env.KV.put("last-visit", new Date().toISOString());
    const lastVisit = await env.KV.get("last-visit");

    return Response.json({
      message: "Hello from Alchemy!",
      timestamp: new Date().toISOString(),
      lastVisit: lastVisit,
      apiKey: env.API_KEY, // TypeScript knows this is a string
    });
  },
};
```

> [!NOTE]
> The `typeof worker.Env` type infers types directly from your infrastructure definition in `alchemy.run.ts`. No code generation required!

> [!TIP]
> You can also infer types for `import { env } from "cloudflare:workers"`, see the [type-safe bindings](./concepts/bindings.md#type-safe-bindings) documentation to learn more.

## Understanding State

After running your app, Alchemy creates a `.alchemy` directory to store state:

```sh
.alchemy/
  my-first-app/         # app
    dev/                # stage
      hello-worker.json # resource state
```

State files help Alchemy determine whether to create, update, delete, or skip resources on subsequent runs.

> [!TIP]
> For production environments or CI/CD, you should use a persistent state store like [DOStateStore](./concepts/state.md#durable-objects-state-store-recommended) (preferred) or [R2RestStateStore](./concepts/state.md#r2-rest-state-store).

## Local Development

Alchemy currently relies on `wrangler` CLI for local development.

You can generate a `wrangler.json` from your `Worker` using the [`WranglerJson`](./providers/cloudflare/wrangler.json.md) Resource:

```typescript
// Add this import
import { WranglerJson } from "alchemy/cloudflare";

// ... after creating the worker with bindings ...

// Generate wrangler.json for local development
await WranglerJson("wrangler.json", {
  worker,
});
```

Deploy again to generate the `wrangler.json` with your bindings:

::: code-group

```sh [bun]
bun ./alchemy.run.ts
```

```sh [npm]
npx tsx ./alchemy.run.ts
```

```sh [pnpm]
pnpm tsx ./alchemy.run.ts
```

```sh [yarn]
yarn tsx ./alchemy.run.ts
```

:::

Now you can your worker locally using `wrangler dev`:

```sh
wrangler dev
```

Visit `http://localhost:8787` to test your worker locally with all your bindings!

## Tear Down

When you're done, you can destroy all resources:

::: code-group

```sh [bun]
bun ./alchemy.run.ts --destroy
```

```sh [npm]
npx tsx ./alchemy.run.ts --destroy
```

```sh [pnpm]
pnpm tsx ./alchemy.run.ts --destroy
```

```sh [yarn]
yarn tsx ./alchemy.run.ts --destroy
```

:::

Output:

```
Delete:  "my-first-app/dev/hello-worker"
Deleted: "my-first-app/dev/hello-worker"
```

Your worker is now removed from Cloudflare.

## Next Steps

You've successfully deployed your first Cloudflare Worker with Alchemy! Here are some next steps:

- [Deploy a ViteJS site to Cloudflare](./guides/cloudflare-vitejs) - Build full-stack applications
- [Learn about Cloudflare Workers](./guides/cloudflare-worker) - Advanced worker features
- [Build your own Custom Resource](./guides/custom-resources.md) - Extend Alchemy
