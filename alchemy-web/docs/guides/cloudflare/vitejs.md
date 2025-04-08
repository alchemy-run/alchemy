---
order: 1
---

# Deploy ViteJS Static Site

This guide is Part 1 in our Cloudflare and Alchemy series. We'll create a Vite.js React TypeScript application and deploy it to Cloudflare Pages.

## Creating a Vite.js Project

Create a new Vite.js project with React and TypeScript:

```bash
bun create vite my-cloudflare-app --template react-ts
cd my-cloudflare-app
bun install
```

## Creating alchemy.run.ts

Create an `alchemy.run.ts` file in your project root:

```typescript
// alchemy.run.ts
import "@types/node";

import alchemy from "alchemy";
import { StaticSite } from "alchemy/cloudflare";

const app = alchemy("cloudflare-vite", {
  stage: process.env.USER ?? "dev",
  phase: process.argv.includes("--destroy") ? "destroy" : "up",
  quiet: process.argv.includes("--verbose") ? false : true,
});

export const website = await StaticSite("Website", {
  name: "my-cloudflare-app",
  dir: "./dist",
  build: {
    command: "bun run build",
  },
});

console.log({
  url: website.url,
});

await app.finalize();
```

## StaticSite Resource

The StaticSite resource configures a Cloudflare Worker that serves cached static assets from a KV namespace:

```typescript
export const website = await StaticSite("Website", {
  name: "my-cloudflare-app", // Worker name
  dir: "./dist",             // Vite build output
  build: {
    command: "bun run build", // Build command
  },
});
```

## Running the Alchemy App

Deploy your app to Cloudflare Pages:

```bash
bun ./alchemy.run.ts
```

Expected output:

```
Create:  "cloudflare-vite/dev/Website"
Building my-cloudflare-app...
Running build command: bun run build
✓ Built my-cloudflare-app
Uploading files to my-cloudflare-app...
✓ Uploaded 15 files to my-cloudflare-app
Created: "cloudflare-vite/dev/Website"
{
  url: "https://alchemy-web.alchemy-run.workers.dev"
}
```

## Examining the State

Alchemy creates a state directory with deployment information:

```
.alchemy/
  cloudflare-vite/
    dev/
      Website.json
```

This tracks your StaticSite resource state for future updates.

## Destroying Resources

To remove all deployed resources:

```bash
bun ./alchemy.run.ts --destroy
```

Expected output:

```
Delete:  "cloudflare-vite/dev/Website"
Deleting my-cloudflare-app...
✓ Deleted my-cloudflare-app
Deleted: "cloudflare-vite/dev/Website"
```

