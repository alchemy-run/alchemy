# Vite

The Vite component lets you deploy a [Vite](https://vitejs.dev/) application to Cloudflare Workers.

# Minimal Example

Deploy a basic Vite app to Cloudflare Workers:

```ts
import { Vite } from "alchemy/cloudflare";

const app = await Vite("my-app", {
  name: "my-app",
  entrypoint: "./src/worker.ts"
});
```

# With Custom Bindings

Add bindings to access other Cloudflare resources:

```ts
import { Vite, KVNamespace, R2Bucket } from "alchemy/cloudflare";

const storage = await R2Bucket("storage", {
  name: "my-storage"
});

const cache = await KVNamespace("cache", {
  title: "my-cache"
});

const app = await Vite("my-app", {
  name: "my-app", 
  entrypoint: "./src/worker.ts",
  bindings: {
    STORAGE: storage,
    CACHE: cache
  }
});
```

# With Custom Build Command

Customize the build command and output directory:

```ts
import { Vite } from "alchemy/cloudflare";

const app = await Vite("my-app", {
  name: "my-app",
  command: "npm run build",
  assets: "./dist/client",
  entrypoint: "./dist/server/entry.mjs"
});
```