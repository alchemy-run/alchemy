---
title: R2Bucket
description: Learn how to create, configure, and manage Cloudflare R2 Buckets using Alchemy for scalable object storage.
---

Creates and manages [Cloudflare R2 Buckets](https://developers.cloudflare.com/r2/buckets/) for object storage with S3 compatibility.

## Minimal Example

Create a basic R2 bucket with default settings:

```ts
import { R2Bucket } from "alchemy/cloudflare";

const bucket = await R2Bucket("my-bucket", {
  name: "my-bucket",
});
```

## With Location Hint

Create a bucket with location hint for optimal performance:

```ts
import { R2Bucket } from "alchemy/cloudflare";

const euBucket = await R2Bucket("eu-bucket", {
  name: "eu-bucket",
  locationHint: "eu",
  jurisdiction: "eu",
});
```

## With Public Access

Create a development bucket with public access enabled:

```ts
import { R2Bucket } from "alchemy/cloudflare";

const publicBucket = await R2Bucket("public-assets", {
  name: "public-assets",
  allowPublicAccess: true,
});
console.log(publicBucket.domain); // [random-id].r2.dev
```

This enables the `r2.dev` domain for the bucket. This URL is rate-limited and not recommended for production use.

## With CORS

Create a bucket with CORS rules:

```ts
import { R2Bucket } from "alchemy/cloudflare";

const corsBucket = await R2Bucket("cors-bucket", {
  name: "cors-bucket",
  cors: [
    {
      allowed: {
        origins: ["https://example.com"],
        methods: ["GET", "POST", "PUT", "DELETE", "HEAD"],
        headers: ["*"],
      },
    },
  ],
});
```

## With Auto-Emptying

Create a bucket that will be automatically emptied when deleted:

```ts
import { R2Bucket } from "alchemy/cloudflare";

const tempBucket = await R2Bucket("temp-storage", {
  name: "temp-storage",
  empty: true, // All objects will be deleted when this resource is destroyed
});
```

## Bind to a Worker

```ts
import { Worker, R2Bucket } from "alchemy/cloudflare";

const bucket = await R2Bucket("my-bucket", {
  name: "my-bucket",
});

await Worker("my-worker", {
  name: "my-worker",
  script: "console.log('Hello, world!')",
  bindings: {
    BUCKET: bucket,
  },
});
```
