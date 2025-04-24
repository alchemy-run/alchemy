# R2Bucket

The R2Bucket component lets you create and manage [Cloudflare R2 buckets](https://developers.cloudflare.com/r2/buckets/) for object storage.

# Minimal Example

Create a basic R2 bucket with default settings:

```ts
import { R2Bucket } from "alchemy/cloudflare";

const bucket = await R2Bucket("my-bucket", {
  name: "my-bucket"
});
```

# With Location Hint

Create a bucket with location hint for optimal performance:

```ts
import { R2Bucket } from "alchemy/cloudflare";

const euBucket = await R2Bucket("eu-bucket", {
  name: "eu-bucket", 
  locationHint: "eu",
  jurisdiction: "eu"
});
```

# With Public Access

Create a development bucket with public access enabled:

```ts
import { R2Bucket } from "alchemy/cloudflare";

const publicBucket = await R2Bucket("public-assets", {
  name: "public-assets",
  allowPublicAccess: true
});
```

# With Auto-Emptying

Create a bucket that will be automatically emptied when deleted:

```ts
import { R2Bucket } from "alchemy/cloudflare";

const tempBucket = await R2Bucket("temp-storage", {
  name: "temp-storage",
  empty: true // All objects will be deleted when destroyed
});
```

# Bind to a Worker

```ts
import { Worker, R2Bucket } from "alchemy/cloudflare";

const bucket = await R2Bucket("my-bucket", {
  name: "my-bucket"
});

await Worker("my-worker", {
  name: "my-worker",
  script: "console.log('Hello, world!')",
  bindings: {
    BUCKET: bucket
  }
});
```