---
order: 2
title: React Router
description: Step-by-step guide to deploying a React Router (formerly Remix) application to Cloudflare Workers using Alchemy.
---

# React Router

This guide demonstrates how to deploy a [React Router](https://reactrouter.com/) (formerly Remix.js) application to Cloudflare with Alchemy.

## Init

Start by creating a new React Router project using Alchemy:

::: code-group

```sh [bun]
bunx alchemy create my-react-router-app --template=react-router
cd my-react-router-app
```

```sh [npm]
npx alchemy create my-react-router-app --template=react-router
cd my-react-router-app
```

```sh [pnpm]
pnpm dlx alchemy create my-react-router-app --template=react-router
cd my-react-router-app
```

```sh [yarn]
yarn dlx alchemy create my-react-router-app --template=react-router
cd my-react-router-app
```

:::

## Login

Before you can deploy, you need to authenticate by running `wrangler login`.

::: code-group

```sh [bun]
bun wrangler login
```

```sh [npm]
npx wrangler login
```

```sh [pnpm]
pnpm wrangler login
```

```sh [yarn]
yarn wrangler login
```

:::

> [!TIP]
> Alchemy will by default try and use your wrangler OAuth token and Refresh Token to connect but see the [Cloudflare Auth](../guides/cloudflare-auth.md) for other methods.

## Deploy

Now we can run and deploy our Alchemy stack:

::: code-group

```sh [bun]
bun run deploy
```

```sh [npm]
npm run deploy
```

```sh [pnpm]
pnpm run deploy
```

```sh [yarn]
yarn run deploy
```

:::

It will log out the URL of your new React Router website hosted on Cloudflare:

```
{
  url: "https://website.${your-sub-domain}.workers.dev",
}
```

## Local

::: code-group

```sh [bun]
bun run dev
```

```sh [npm]
npm run dev
```

```sh [pnpm]
pnpm run dev
```

```sh [yarn]
yarn run dev
```

:::

## Destroy

For illustrative purposes, let's destroy the Alchemy stack:

::: code-group

```sh [bun]
bun run destroy
```

```sh [npm]
npm run destroy
```

```sh [pnpm]
pnpm run destroy
```

```sh [yarn]
yarn run destroy
```

:::

## Explore

### `.env`

Alchemy requires a locally set password to encrypt Secrets that are stored in state. Be sure to change this.

> [!NOTE]
> See the [Secret](../concepts/secret.md) documentation to learn more.

```
ALCHEMY_PASSWORD=change-me
```

### `alchemy.run.ts`

The `alchemy.run.ts` file contains your infrastructure setup:

```typescript
/// <reference types="@types/node" />

import alchemy from "alchemy";
import { ReactRouter } from "alchemy/cloudflare";

const app = await alchemy("my-react-router-app");

export const worker = await ReactRouter("website", {
  main: "./workers/app.ts",
  command: "bun run build",
});

console.log({
  url: worker.url,
});

await app.finalize();
```

### `types/env.d.ts`

The `types/env.d.ts` file provides type-safe access to Cloudflare bindings:

```typescript
// This file infers types for the cloudflare:workers environment from your Alchemy Worker.
// @see https://alchemy.run/docs/concepts/bindings.html#type-safe-bindings

import type { worker } from "../alchemy.run.ts";

export type CloudflareEnv = typeof worker.Env;

declare global {
  type Env = CloudflareEnv;
}

declare module "cloudflare:workers" {
  namespace Cloudflare {
    export interface Env extends CloudflareEnv {}
  }
}
```

### `tsconfig.node.json`

The CLI updated the `tsconfig.node.json` to include `alchemy.run.ts` and register `@cloudflare/workers-types` + `types/env.d.ts` globally

> [!TIP]
> The `alchemy.run.ts` script will be run by `node` but still needs to infer the [Binding](../concepts/bindings.md) types which depends on `@cloudflare/workers-types`:

```json
{
  "extends": "./tsconfig.json",
  "include": [
    "vite.config.ts",
    // ensure our types and alchemy.run.ts are included
    "types/**/*.ts",
    "alchemy.run.ts"
  ],
  "compilerOptions": {
    "composite": true,
    "strict": true,
    // register cloudflare types and our Env types globally
    "types": ["@cloudflare/workers-types", "./types/env.d.ts"],
    "lib": ["ES2022"],
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler"
  }
}
```
