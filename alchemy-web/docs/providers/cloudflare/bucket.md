# R2 Bucket

The R2 Bucket resource lets you create and manage [Cloudflare R2 object storage buckets](https://developers.cloudflare.com/r2/buckets/) for storing and serving files.

## Minimal Example

Create a basic R2 bucket with default settings:

```ts
import { R2Bucket } from "alchemy/cloudflare";

const bucket = await R2Bucket("my-bucket", {
  name: "my-bucket"
});
```

## Create with Location Hint

Create a bucket with location hint for optimal performance:

```ts
import { R2Bucket } from "alchemy/cloudflare";

const euBucket = await R2Bucket("eu-bucket", {
  name: "eu-bucket",
  locationHint: "eu",
  jurisdiction: "eu"
});
```

## Bind to a Worker

Bind an R2 bucket to a Worker for direct access:

```ts
import { Worker, R2Bucket } from "alchemy/cloudflare";

const storage = await R2Bucket("storage", {
  name: "storage-bucket"
});

await Worker("my-worker", {
  name: "my-worker",
  script: "console.log('Hello, world!')",
  bindings: {
    STORAGE: storage
  }
});
```