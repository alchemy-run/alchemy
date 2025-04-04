# R2 Bucket

The R2 Bucket resource lets you create and manage [Cloudflare R2 object storage buckets](https://developers.cloudflare.com/r2/buckets/) for storing and serving files.

## Minimal Example

Create a basic R2 bucket for storing application data.

```ts
import { R2Bucket } from "alchemy/cloudflare";

const bucket = await R2Bucket("my-bucket", {
  name: "my-app-data"
});
```

## Create a Bucket with Location Hint

```ts
import { R2Bucket } from "alchemy/cloudflare";

const bucket = await R2Bucket("eu-bucket", {
  name: "eu-user-data",
  locationHint: "eu",
  jurisdiction: "eu"
});
```

## Create a Development Bucket with Public Access

```ts
import { R2Bucket } from "alchemy/cloudflare";

const bucket = await R2Bucket("public-bucket", {
  name: "public-assets",
  allowPublicAccess: true
});
```

## Bind to a Worker

```ts
import { Worker, R2Bucket } from "alchemy/cloudflare";

const storage = await R2Bucket("storage", {
  name: "user-uploads"
});

await Worker("storage-worker", {
  name: "storage-worker",
  script: "console.log('Hello from storage worker!')",
  bindings: {
    STORAGE: storage
  }
});
```