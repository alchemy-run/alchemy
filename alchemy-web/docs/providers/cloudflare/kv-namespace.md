# KV Namespace

The KV Namespace component allows you to create and manage [Cloudflare Workers KV](https://developers.cloudflare.com/workers/kv/) namespaces, which are key-value stores for your application.

# Minimal Example

```ts
import { KVNamespace } from "alchemy/cloudflare";

const myNamespace = await KVNamespace("my-namespace", {
  title: "example-namespace"
});
```

# Create the KV Namespace

```ts
import { KVNamespace } from "alchemy/cloudflare";

const userSessions = await KVNamespace("user-sessions", {
  title: "user-sessions",
  values: [
    {
      key: "session_123",
      value: { userId: "user_456", role: "admin" },
      expirationTtl: 3600 // Expires in 1 hour
    }
  ]
});
```

# Bind to a Worker

```ts
import { Worker, KVNamespace } from "alchemy/cloudflare";

const myNamespace = await KVNamespace("my-namespace", {
  title: "example-namespace"
});

await Worker("my-worker", {
  name: "my-worker",
  script: "console.log('Hello, world!')",
  bindings: {
    myNamespace,
  },
});
```