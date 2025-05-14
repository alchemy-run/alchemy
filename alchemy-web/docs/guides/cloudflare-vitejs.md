---
order: 1
title: Vite.js
description: Step-by-step guide to deploying Vite.js React applications with API endpoints to Cloudflare Workers using Alchemy's Infrastructure-as-Code approach.
---

# Vite

This guide demonstrates how to deploy a Vite.js React TypeScript application with a Hono API to Cloudflare using Alchemy.

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

Update your `tsconfig.node.json` to register `@cloudflare/workers-types` globally:

```json
{
  "compilerOptions": {
    // make sure to register this globally
    "types": ["@cloudflare/workers-types",],
  }
}
```

## Create `alchemy.run.ts`

```ts
// ./alchemy.run.ts
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

## Create Vite

Import the `Vite` and configure your build command and assets directory:

```ts
import { Vite } from "alchemy/cloudflare";

export const website = await Vite("website", {
  // command to build the vite site (run vite build)
  command: "bun run build",
  // OPTIONAL: override where the dist is, it defaults to ./dist/client
  // assets: "./dist/client",
});
```

Log out the website's URL:
```ts
console.log({
  url: website.url
})
```

## Deploy Static Site

Login to Cloudflare:

```sh
wrangler login
```

Run `alchemy.run.ts` script to deploy:

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

## Add a Backend API

Create an entrypoint for your server, `src/index.ts` with a Hono app:

```ts
import { env } from "cloudflare:workers";

export const api = new Hono();

// create a route
api.get("/hello", (c) => c.text("Hello World"));

export default {
  async fetch(request: Request): Promise<Response> {
    return api.fetch(request)
  },
};
```

Update `Vite` to use our custom server entrypoint:

```ts
export const website = await Vite("website", {
  command: "bun run build",
  assets: "./dist",
  // configure our server's entrypoint
  main: "./src/index.ts"
});
```

## Deploy Static Site and API

Re-run to deploy the new worker code:

```sh
bun ./alchemy.run
```

Test the API route is set up correctly with `curl`:

```sh
curl https://your-site.workers.dev/api/hello
```

It should output:
```
Hello World
```

> [!TIP]
> You can call this API from your frontend code with `fetch`:
>
> ```ts
> await fetch(`${window.origin}/api/hello`)
> ```

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

Now you can run `vite dev`:
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

That's it! You can now tear down the app (if you want to):

```bash
bun ./alchemy.run --destroy
```

