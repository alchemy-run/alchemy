# Bindings

The Bindings component allows you to define and manage [Cloudflare Worker bindings](https://developers.cloudflare.com/workers/platform/bindings/) for your application. These bindings enable your Worker to interact with various Cloudflare services like KV namespaces, Durable Objects, R2 Buckets, and more.

# Minimal Example

```ts
import { Bindings } from "alchemy/cloudflare";

const myBindings: Bindings = {
  MY_KV_NAMESPACE: "my-kv-namespace",
  MY_SECRET: "my-secret-value",
};
```

# Create the Bindings

```ts
import { Bindings } from "alchemy/cloudflare";

const myBindings: Bindings = {
  MY_KV_NAMESPACE: "my-kv-namespace",
  MY_SECRET: "my-secret-value",
  MY_R2_BUCKET: "my-r2-bucket",
};
```

# Bind to a Worker

```ts
import { Worker, Bindings } from "alchemy/cloudflare";

const myBindings: Bindings = {
  MY_KV_NAMESPACE: "my-kv-namespace",
  MY_SECRET: "my-secret-value",
};

const myWorker = await Worker("my-worker", {
  name: "my-worker",
  script: "console.log('Hello, world!')",
  bindings: myBindings,
});
```

This documentation provides a concise overview of how to define and use Bindings in Cloudflare Workers using the Alchemy framework. The examples demonstrate creating bindings and associating them with a Worker, enabling seamless integration with Cloudflare services.