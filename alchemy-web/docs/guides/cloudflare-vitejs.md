---
order: 1
---

# Cloudflare ViteJS

This guide shows how to deploy a Vite.js React TypeScript application to Cloudflare using Alchemy.

## Create a new Vite.js Project

Start by creating a new Vite.js project:

```bash
bun create vite my-cloudflare-app --template react-ts
cd my-cloudflare-app
bun install
```

Install `cloudflare` and `alchemy`:
```sh
bun add alchemy cloudflare
```

Update your `tsconfig.json` to register `@cloudflare/workers-types` globally:

```json
{
  "compilerOptions": {
    // make sure to register this globally
    "types": ["@cloudflare/workers-types",],
  },
  "include": ["src/**/*.ts", "src/**/*.tsx"]
}
```

## Set up Cloudflare Credentials

Create a `.env` file in the root of the new project and place your Cloudflare Account's Email and API Key:

```
CLOUDFLARE_API_KEY=<your-api-key>
CLOUDFLARE_EMAIL=<account-email>
```

> [!TIP]
> Use the "Global API Key" from https://dash.cloudflare.com/profile/api-tokens

## Create `alchemy.run.ts`

Create a standard `alchemy.run.ts` file in your project root:

```ts
import alchemy from "alchemy";

const app = await alchemy("cloudflare-vite", {
  stage: process.env.USER ?? "dev",
  phase: process.argv.includes("--destroy") ? "destroy" : "up",
  quiet: process.argv.includes("--verbose") ? false : true,
});

// (resources go here)

await app.finalize(); // must be at end
```

> [!NOTE]
> See the [Getting Started](../getting-started) guide if this is unfamiliar.

## Create Vite.js Resource

Import the `ViteSite` and configure your build command and assets directory:

```ts
import { ViteSite } from "alchemy/cloudflare";

export const website = await ViteSite("website", {
  // command to build the vite site (run vite build)
  command: "bun run build",
  // where the build command will store the assets
  assets: "./dist",
});
```

## Log Website URL

Log out the website's URL:
```ts
console.log({
  url: website.url
})
```

## Deploy to Cloudflare

Deploy by simply running you `alchemy.run.ts` script, e.g. with `bun`:

```sh
bun ./alchemy.run
```

It should log out the URL of your deployed site:
```sh
{
  url: "https://your-site.your-sub-domain.workers.dev",
}
```

Click the endpoint to see your site!

## Add a Backend API with Hono

Let's now add a backend API route with Hono.

Start by creating an entrypoint for our server, `src/index.ts`:

```ts
import { env } from "cloudflare:workers";

export default {
  async fetch(request: Request): Promise<Response> {
    return env.ASSETS.fetch(request);
  },
};
```

> [!NOTE]
> This basic entrypoint simply serves the static assets and was automatically injected 

Update the `StaticSite` to use our custom server entrypoint:

```ts
export const website = await ViteSite("website", {
  command: "bun run build",
  assets: "./dist",
  // configure our server's entrypoint
  main: "./src/index.ts"
});
```

## Create `./src/api.ts`

```ts
import { Hono } from "hono";

export const api = new Hono();

// create a route
api.get("/hello", (c) => c.text("Hello World"));
```

## Route `/api/*` to the Hono `api`

Modify `src/index.ts` to serve any `/api/*` requests with a Hono app:

```ts
import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { api } from "./api";

// create a root Hono app
const app = new Hono();

// and route /api/ to the api hono app
app.route("/api/", api);

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      // route /api/* to our API
      return app.fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};
```

> [!TIP]
> It's a good practice to use `app.route` to partition routes behind a prefix like `/api/` to simplify routing (see below)

## Configure the Worker Environment Types

Your server won't yet compile - first, we need to set up the types for our Worker's Environment.

For that, create a `./src/env.d.ts` file and paste the following:

```ts
/// <reference types="./env.d.ts" />

import type { website } from "./alchemy.run";

export type WorkerEnv = typeof website.Env;

declare module "cloudflare:workers" {
  namespace Cloudflare {
    export interface Env extends WorkerEnv {}
  }
}
```

> [!TIP]
> See the [Bindings](../concepts/bindings.md) documentation to learn more.

## Deploy the Site + API

```sh
bun ./alchemy.run
```

## Local Development

Edit the `./vite.config.ts` file and configure the `cloudflare()` plugin:

```ts
import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), cloudflare()],
});
```

Finally, run `vite dev` 
```sh
bun vite dev
```

The vite dev server will start as normal, along with your Worker and Cloudflare Resources running locally in miniflare (matching a deployment as closely as possible).

```sh
VITE v6.2.2  ready in 1114 ms

➜  Local:   http://localhost:5173/
➜  Network: use --host to expose
➜  Debug:   http://localhost:5173/__debug
➜  press h + enter to show help
```

## Tear Down

That's it! You can now tear down the app:

```bash
bun ./alchemy.run --destroy
```

