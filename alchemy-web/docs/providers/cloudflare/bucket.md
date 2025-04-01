# Bucket

The Bucket component allows you to create and manage [Cloudflare R2 Buckets](https://developers.cloudflare.com/r2/buckets/), which provide S3-compatible object storage with automatic data replication across multiple regions for high availability and durability.

# Minimal Example

```ts
import { R2Bucket } from "alchemy/cloudflare";

const myBucket = await R2Bucket("my-bucket", {
  name: "my-bucket"
});
```

# Create the Bucket

```ts
import { R2Bucket } from "alchemy/cloudflare";

const myBucket = await R2Bucket("my-bucket", {
  name: "my-bucket",
  locationHint: "us-east-1",
  jurisdiction: "default",
  allowPublicAccess: false
});
```

# Bind to a Worker

```ts
import { Worker, R2Bucket } from "alchemy/cloudflare";

const myBucket = await R2Bucket("my-bucket", {
  name: "my-bucket",
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