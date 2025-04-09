# R2Bucket

Creates and manages [Cloudflare R2 Buckets](https://developers.cloudflare.com/r2/buckets/) for S3-compatible object storage.

# Minimal Example

Create a basic R2 bucket with default settings:

```ts
import { R2Bucket } from "alchemy/cloudflare";

const bucket = await R2Bucket("my-bucket", {
  name: "my-bucket"
});
```

# With Location Hint and Jurisdiction

Create a bucket with location hint and jurisdiction for data residency:

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

const publicBucket = await R2Bucket("public-bucket", {
  name: "public-bucket", 
  allowPublicAccess: true
});
```

# Bind to a Worker

Bind an R2 bucket to a Cloudflare Worker:

```ts
import { Worker, R2Bucket } from "alchemy/cloudflare";

const bucket = await R2Bucket("storage", {
  name: "my-storage"
});

await Worker("api", {
  name: "api-worker",
  script: "export default { fetch() {} }",
  bindings: {
    STORAGE: bucket
  }
});
```