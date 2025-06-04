---
order: 3
title: SvelteKit
description: Step-by-step guide to deploying a SvelteKit application to Cloudflare Workers using Alchemy with KV storage and R2 buckets.
---

# SvelteKit

This guide walks through how to deploy a SvelteKit application to Cloudflare Workers with Alchemy.

## Create a new SvelteKit Project

Start by creating a new SvelteKit project:

```sh
bun create svelte@latest my-sveltekit-app
cd my-sveltekit-app
bun install
```

> [!NOTE]
> See Svelte's [Introduction](https://svelte.dev/docs/kit/introduction) guide for more details on SvelteKit applications.

## Install Cloudflare Adapter and Dependencies

Install the required dependencies:

```sh
bun add @sveltejs/adapter-cloudflare alchemy cloudflare
bun add -D @cloudflare/workers-types
```

## Configure SvelteKit for Cloudflare

Update your `svelte.config.js` to use the Cloudflare adapter:

```js
import adapter from '@sveltejs/adapter-cloudflare';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		adapter: adapter()
	}
};

export default config;
```

## Create `alchemy.run.ts`

Create an `alchemy.run.ts` file in the root of your project:

```ts
import alchemy from "alchemy";
import { KVNamespace, R2Bucket, SvelteKit } from "alchemy/cloudflare";

const app = await alchemy("my-sveltekit-app", {
  stage: process.env.USER ?? "dev",
  phase: process.argv.includes("--destroy") ? "destroy" : "up",
});

const website = await SvelteKit("sveltekit-website", {
  bindings: {
    AUTH_STORE: await KVNamespace("auth-store", {
      title: "my-sveltekit-auth-store",
    }),
    STORAGE: await R2Bucket("storage", {
      allowPublicAccess: false,
    }),
  },
  url: true,
});

console.log({
  url: website.url,
});

await app.finalize();
```

## Configure SvelteKit Types

Update `src/app.d.ts` for Cloudflare bindings:

```ts
declare global {
	namespace App {
		interface Platform {
			env: {
				STORAGE: R2Bucket;
				AUTH_STORE: KVNamespace;
			};
			context: ExecutionContext;
			caches: CacheStorage & { default: Cache };
		}
	}
}

export {};
```

## Using Cloudflare Bindings

In your SvelteKit routes, access Cloudflare resources via `platform.env`:

```ts
// +page.server.ts
export const load = async ({ platform }) => {
	const kvData = await platform?.env?.AUTH_STORE?.get('some-key');
	const r2Object = await platform?.env?.STORAGE?.get('some-file');
	return { kvData };
};
```

## Deploy Your Application

Login to Cloudflare:

```sh
wrangler login
```

Run your Alchemy script to deploy the application:

```sh
bun ./alchemy.run
```

It should output the URL of your deployed site:

```sh
{
  url: "https://your-site.your-sub-domain.workers.dev",
}
```

## Local Development

To run your application locally:

```sh
bun run dev
```

## Tear Down

When you're finished experimenting, you can tear down the application:

```sh
bun ./alchemy.run --destroy
```

This will remove all Cloudflare resources created by this deployment. 