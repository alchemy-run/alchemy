# KVNamespace

The KVNamespace resource lets you create and manage [Cloudflare KV Namespaces](https://developers.cloudflare.com/kv/concepts/kv-namespaces/) for key-value storage.

# Minimal Example

Create a basic KV namespace for storing user data:

```ts
import { KVNamespace } from "alchemy/cloudflare";

const users = await KVNamespace("users", {
  title: "user-data"
});
```

# With Initial Values

Create a KV namespace with initial key-value pairs and TTL:

```ts
import { KVNamespace } from "alchemy/cloudflare";

const sessions = await KVNamespace("sessions", {
  title: "user-sessions",
  values: [{
    key: "session_123",
    value: { userId: "user_456", role: "admin" },
    expirationTtl: 3600 // Expires in 1 hour
  }]
});
```

# With Metadata

Create a KV namespace with metadata for caching:

```ts
import { KVNamespace } from "alchemy/cloudflare";

const assets = await KVNamespace("assets", {
  title: "static-assets", 
  values: [{
    key: "main.js",
    value: "content...",
    metadata: {
      contentType: "application/javascript",
      etag: "abc123"
    }
  }]
});
```

# Bind to a Worker

Bind a KV namespace to a Cloudflare Worker:

```ts
import { Worker, KVNamespace } from "alchemy/cloudflare";

const kv = await KVNamespace("my-kv", {
  title: "my-kv-namespace"
});

await Worker("my-worker", {
  name: "my-worker",
  script: "console.log('Hello, world!')",
  bindings: {
    MY_KV: kv
  }
});
```