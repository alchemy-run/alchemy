# R2 Rest State Store

The R2 Rest State Store allows you to use Cloudflare's R2 object storage as a state store for your application. This provides immediate consistency compared to KV's eventual consistency. Learn more about [Cloudflare R2](https://developers.cloudflare.com/r2/).

# Minimal Example

```ts
import { R2RestStateStore } from "alchemy/cloudflare";

const stateStore = new R2RestStateStore(scope, {
  bucketName: "my-bucket",
});
```

# Create the R2 Rest State Store

```ts
import { R2RestStateStore } from "alchemy/cloudflare";

const stateStore = new R2RestStateStore(scope, {
  bucketName: "my-bucket",
  prefix: "my-app/",
  apiKey: process.env.CLOUDFLARE_API_KEY,
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
  email: process.env.CLOUDFLARE_EMAIL,
});
```

# Bind to a Worker

```ts
import { Worker, R2RestStateStore } from "alchemy/cloudflare";

const stateStore = new R2RestStateStore(scope, {
  bucketName: "my-bucket",
});

await Worker("my-worker", {
  name: "my-worker",
  script: "console.log('Hello, world!')",
  bindings: {
    stateStore,
  },
});
```