---
title: Alchemy Vite Plugin
excerpt: Bye-bye wrangler.json and .dev.vars, hello alchemy()
date: 2025-08-05
author: Sam Goodwin
---

Alchemy now has its own plugins for Vite, Astro, SvelteKit, Redwood, and Tanstack Start that is a drop-in replacement for the `cloudflare` plugin and eliminates the need for a `wrangler.json`, a `.dev.vars` file or custom Miniflare persist path for local development.

:::note
__TLDR__: update your `vite.config.ts` file to use the `alchemy` plugin instead of the `cloudflare` plugin for a smoother experience:

```diff lang='ts'
import { defineConfig } from "vite";
-import { cloudflare } from "@cloudflare/vite-plugin";
+import alchemy from "alchemy/cloudflare/vite";

export default defineConfig({
-  plugins: [cloudflare()],
+  plugins: [alchemy()],
});
```
:::

## What problem does it solve?

When deploying a Web app in Alchemy, you set secrets using the `bindings` property:

```ts
await Vite("website", {
  bindings: {
    SOME_SECRET: alchemy.secret.env.SOME_SECRET,
  }
})
```

✅ Deploying this to Cloudflare has always worked fine:
```sh
alchemy deploy
```

`alchemy deploy` runs `vite build`, uploads it to Cloudflare with all the right environment variables and secrets. 

⛔️ Developing locally is where you run into snags:

```sh
alchemy dev
```

This will get your worker running locally in Miniflare, but it won't include any of your environment variables or secrets! 😤

This is because Cloudflare's vite plugin expects secrets to be in a `.dev.vars` file and ignores all other environment variables.

## The old workaround

The workaround was to replicate these values to the `.dev.vars` file like so:

```sh
VITE_SOME_VAR=some-value
SOME_SECRET=some-secret
```

You already have your secrets configured in your `alchemy.run.ts` file, so why replicate them to a `.dev.vars` file? 

## The new solution

Alchemy's `Website` resources (and its variants like `Vite`, `Astro`, etc.) now automatically generate a temporary `wrangler.json` file in `.alchemy/local/wrangler.json`.

Unlike a typical `wrangler.json` file, we also include your secrets in plain text.

```diff lang='json'
{
  "name": "website",
  "main": "./src/worker.ts",
  "compatibility_date": "2025-08-02",
  "assets": { "directory": "./dist/client", "binding": "ASSETS" },
+  "vars": { "SOME_SECRET": "super secret value!" },
}
```

:::note
This is secure because it's only used for configuring Miniflare locally. 
:::

Alchemy's `alchemy` vite plugin takes care of configuring the custom `wrangler.json` file, Miniflare persistence state path, and remote bindings:

```diff lang='ts'
export default defineConfig({
-  plugins: [
-    cloudflare({ 
-      path: process.env.ALCHEMY_CLOUDFLARE_PERSIST_PATH ,
-      configPath: ".alchemy/local/wrangler.json",
-      experimental: { remoteBindings: true }
-    })
-  ],
+  plugins: [alchemy()],
});
```


## Other frameworks

This blog mostly focused on Vite, but we also vend similar plugins for other frameworks that behave differently than Vite.

### Astro

```diff lang='ts'
-import { cloudflare } from '@cloudflare/astro-plugin';
+import alchemy from 'alchemy/cloudflare/astro';
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
  output: 'server',
  adapter: alchemy(),
});
```

### SvelteKit

```diff lang='ts'
// svelte.config.mjs
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
-import adapter from '@sveltejs/adapter-cloudflare';
+import alchemy from 'alchemy/cloudflare/sveltekit';

export defaut {
  preprocess: vitePreprocess(),
  kit: {
-    adapter: adapter()
+    adapter: alchemy()
  }
};
```

### Nuxt

```diff lang='ts'
+import alchemy from "alchemy/cloudflare/nuxt";

import { defineNuxtConfig } from "nuxt/config";

export default defineNuxtConfig({
-  compatibilityDate: '2025-05-15',
  devtools: { enabled: true },
  nitro: {
    preset: "cloudflare-module",
-    cloudflare: {
-      deployConfig: true,
-      nodeCompat: true
-    }
+    cloudflare: alchemy(),
    prerender: {
      routes: ["/"],
      autoSubfolderIndex: false,
    },
  },
  modules: ["nitro-cloudflare-dev"],
});
```

### Tanstack Start

```diff lang='ts'
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
-import { cloudflareWorkersDevEnvironmentShim } from "alchemy/cloudflare";
+import alchemy from "alchemy/cloudflare/tanstack-start";
import { defineConfig, PluginOption } from "vite";
import tsConfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  server: {
    port: 3000,
  },
  build: {
    target: "esnext",
    rollupOptions: {
      external: ["node:async_hooks", "cloudflare:workers"],
    },
  },
  plugins: [
    tailwindcss() as PluginOption,
-    cloudflareWorkersDevEnvironmentShim(),
+    alchemy(),
    tsConfigPaths({
      projects: ["./tsconfig.json"],
    }),
    tanstackStart({
      target: "cloudflare-module",
      customViteReactPlugin: true,
    }),
    viteReact(),
  ],
});
```