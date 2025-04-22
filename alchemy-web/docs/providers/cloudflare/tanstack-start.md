# TanStackStart

The TanStackStart component lets you deploy a [TanStack](https://tanstack.com/) application to Cloudflare Workers.

# Minimal Example

Creates a TanStack worker with default configuration.

```ts
import { TanStackStart } from "alchemy/cloudflare";

const app = await TanStackStart("my-app");
```

# Custom Configuration

Customize the worker configuration and bindings.

```ts
import { TanStackStart } from "alchemy/cloudflare";

const app = await TanStackStart("my-app", {
  name: "my-tanstack-app",
  command: "bun run build:custom",
  compatibilityFlags: ["nodejs_compat"],
  bindings: {
    MY_KV: myKv,
    MY_SECRET: alchemy.secret("secret123")
  }
});
```

# Bind to a Worker

Use the TanStack worker as a binding in another worker.

```ts
import { Worker, TanStackStart } from "alchemy/cloudflare";

const app = await TanStackStart("my-app", {
  name: "my-tanstack-app"
});

await Worker("my-worker", {
  name: "my-worker", 
  script: "console.log('Hello, world!')",
  bindings: {
    APP: app
  }
});
```