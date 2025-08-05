---
title: Alchemy's Cloudflare Vite Plugin
date: 2025-08-05
author: Sam Goodwin
---

Alchemy now ships with plugins for Vite, Astro, SvelteKit, Nuxt, React Router, and TanStack Start that streamline local development by eliminating the need for a `.dev.vars` file, configuration of wrangler state paths, and other boilerplate.

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

<!-- excerpt -->

## What problem does it solve?

When deploying a Web app in Alchemy, you set secrets using the `bindings` property:

```ts
await Vite("website", {
  bindings: {
    SOME_SECRET: alchemy.secret.env.SOME_SECRET,
  }
})
```

👍 The `alchemy deploy` command will build and deploy your website to Cloudflare with the `SOME_SECRET` as a secure Binding, as expected.

👎 The `alchemy dev` command, however, would be missing the secret because Cloudflare's Vite plugin only includes environment variables from `.dev.vars`.

## The old workaround

The workaround was to replicate these values to the `.dev.vars` file like so:

```sh
VITE_SOME_VAR=some-value
SOME_SECRET=some-secret
```

But, this is redundant and inflexible. As Alchemy users, we want to maintain our configuration and environments in code.

## The new solution

We updated the `Website` resources (and its variants like `Vite`, `Astro`, etc.) to generate a temporary `wrangler.json` file in `.alchemy/local/wrangler.json` that contains your secrets in plain text:

```diff lang='json'
{
  "name": "website",
  "main": "./src/worker.ts",
  "compatibility_date": "2025-08-02",
  "assets": { "directory": "./dist/client", "binding": "ASSETS" },
+  "vars": { "SOME_SECRET": "super secret value!" },
}
```

`vite dev` will include the `vars` when running your Worker locally, so you no longer need a `.dev.vars` file 🎉.

:::caution
Ensure that `.alchemy` is added to your `.gitignore` to avoid accidentally committing secrets to your repo.
:::

Our new `alchemy` vite plugin takes care of configuring the annoying boilerplate: 

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

:::tip
If you are using a Vite-based framework like React Router or TanStack Start, we recommend using the framework-specific integrations instead of the `alchemy/cloudflare/vite` plugin (see below).
:::

## Other frameworks

This blog mostly focused on Vite, but we also vend similar plugins for other frameworks that behave differently than Vite.

### Astro

```diff title='astro.config.mjs' lang='ts'
-import cloudflare from '@astrojs/cloudflare';
+import alchemy from 'alchemy/cloudflare/astro';
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
  output: 'server',
-  adapter: cloudflare(),
+  adapter: alchemy(),
});
```

### SvelteKit

```diff title='svelte.config.mjs' lang='ts'
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
-import adapter from '@sveltejs/adapter-cloudflare';
+import alchemy from 'alchemy/cloudflare/sveltekit';

export default {
  preprocess: vitePreprocess(),
  kit: {
-    adapter: adapter()
+    adapter: alchemy()
  }
};
```

### Nuxt

```diff title='nuxt.config.ts' lang='ts'
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

### React Router

```diff title='vite.config.ts' lang='ts'
import { reactRouter } from "@react-router/dev/vite";
-import cloudflare from "@cloudflare/vite-plugin";
+import alchemy from "alchemy/cloudflare/react-router";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [
-    cloudflare({
-      viteEnvironment: {
-        name: "ssr",
-      },
-    }),
+    alchemy(),
    reactRouter(),
    tsconfigPaths(),
  ],
});
```

### TanStack Start

```diff title='vite.config.ts' lang='ts'
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
-import { cloudflareWorkersDevEnvironmentShim } from "alchemy/cloudflare";
+import alchemy from "alchemy/cloudflare/tanstack-start";
import { defineConfig } from "vite";
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
