# Bucket

The Bucket component allows you to create and manage [Cloudflare R2 Buckets](https://developers.cloudflare.com/r2/buckets/), providing S3-compatible object storage with automatic data replication across multiple regions for high availability and durability.

# Minimal Example

```ts twoslash
import { R2Bucket } from "alchemy/cloudflare";

const basicBucket = await R2Bucket("my-app-data", {
  name: "my-app-data"
});
```

# Create the Bucket

```ts twoslash
import { R2Bucket } from "alchemy/cloudflare";

const euBucket = await R2Bucket("eu-user-data", {
  name: "eu-user-data",
  locationHint: "eu",
  jurisdiction: "eu"
});
```

# Bind to a Worker

```ts twoslash
import { Worker, R2Bucket } from "alchemy/cloudflare";

const myBucket = await R2Bucket("my-resource", {
  name: "my-resource",
  allowPublicAccess: true
});

await Worker("my-worker", {
  name: "my-worker",
  script: "console.log('Hello, world!')",
  bindings: {
    myBucket,
  },
});
```