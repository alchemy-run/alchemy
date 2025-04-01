# Wrangler JSON

The Wrangler JSON component allows you to configure your Cloudflare Workers using a `wrangler.json` file. This file defines various settings and bindings for your worker, such as KV namespaces, R2 buckets, and environment variables. For more information, visit the [Cloudflare Workers documentation](https://developers.cloudflare.com/workers/).

# Minimal Example

```ts twoslash
import { WranglerJson } from "alchemy/cloudflare";

const config = await WranglerJson("my-worker-config", {
  name: "my-worker",
  main: "src",
  entrypoint: "index.ts",
  outdir: "dist",
  minify: true,
});
```

# Create the Wrangler JSON

```ts twoslash
import { WranglerJson } from "alchemy/cloudflare";

const config = await WranglerJson("my-worker-config", {
  name: "my-worker",
  main: "src",
  entrypoint: "index.ts",
  outdir: "dist",
  assets: "public",
  minify: true,
  node_compat: false,
  vars: {
    API_KEY: "my-api-key",
  },
  kv_namespaces: [
    {
      binding: "MY_KV_NAMESPACE",
      id: "namespace-id",
    },
  ],
  r2_buckets: [
    {
      binding: "MY_R2_BUCKET",
      bucket_name: "my-bucket",
    },
  ],
  routes: ["example.com/*"],
  compatibility_date: "2023-01-01",
});
```

# Bind to a Worker

```ts twoslash
import { Worker, WranglerJson } from "alchemy/cloudflare";

const config = await WranglerJson("my-worker-config", {
  name: "my-worker",
  main: "src",
  entrypoint: "index.ts",
  outdir: "dist",
  minify: true,
});

await Worker("my-worker", {
  name: "my-worker",
  script: "console.log('Hello, world!')",
  bindings: {
    config,
  },
});
```