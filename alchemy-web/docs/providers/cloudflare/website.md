# Website

The Website resource lets you deploy a static website to [Cloudflare Pages](https://developers.cloudflare.com/pages/) with a Worker backend.

# Minimal Example

Deploy a basic static site with a Worker backend:

```ts
import { Website } from "alchemy/cloudflare";

const site = await Website("my-site", {
  name: "my-site",
  command: "npm run build", 
  assets: "./dist",
  entrypoint: "./src/worker.ts"
});
```

# With Custom Domain

Deploy a site with a custom domain:

```ts
import { Website, CustomDomain } from "alchemy/cloudflare";

const site = await Website("my-site", {
  name: "my-site",
  command: "npm run build",
  assets: "./dist",
  entrypoint: "./src/worker.ts"
});

const domain = await CustomDomain("my-domain", {
  name: "www.example.com",
  zoneId: "zone-id",
  workerName: site.name
});
```

# With Bindings

Add KV storage and environment variables to the Worker:

```ts
import { Website, KVNamespace } from "alchemy/cloudflare";

const kv = await KVNamespace("my-kv", {
  title: "my-kv"
});

const site = await Website("my-site", {
  name: "my-site",
  command: "npm run build",
  assets: "./dist", 
  entrypoint: "./src/worker.ts",
  bindings: {
    KV: kv,
    API_KEY: alchemy.secret(process.env.API_KEY)
  }
});
```

# With SPA Mode

Configure for single-page application routing:

```ts
import { Website } from "alchemy/cloudflare";

const spa = await Website("my-spa", {
  name: "my-spa",
  command: "npm run build",
  assets: {
    dist: "./dist",
    not_found_handling: "single-page-application"
  },
  entrypoint: "./src/worker.ts"
});
```

# Bind to a Worker

The Website resource is already a Worker binding:

```ts
import { Worker, Website } from "alchemy/cloudflare";

const site = await Website("my-site", {
  name: "my-site",
  command: "npm run build",
  assets: "./dist"
});

await Worker("my-worker", {
  name: "my-worker", 
  script: "console.log('Hello from worker!')",
  bindings: {
    SITE: site
  }
});
```