# Bucket

The Bucket resource lets you create and manage [Amazon S3 buckets](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html) for scalable object storage.

## Minimal Example

Create a basic S3 bucket with default settings:

```ts
import { Bucket } from "alchemy/aws";

const bucket = await Bucket("assets", {
  bucketName: "my-app-assets",
  tags: {
    Environment: "production",
    Project: "my-app"
  }
});
```

## Versioned Bucket

Create a bucket with versioning enabled and specific tags:

```ts
import { Bucket } from "alchemy/aws";

const versionedBucket = await Bucket("document-archive", {
  bucketName: "document-archive",
  tags: {
    Environment: "production", 
    Purpose: "document-storage",
    Versioning: "enabled"
  }
});
```

## Development Bucket

Create a development bucket with minimal configuration:

```ts
import { Bucket } from "alchemy/aws";

const devBucket = await Bucket("dev-testing", {
  bucketName: "dev-testing",
  tags: {
    Environment: "development",
    Temporary: "true"
  }
});
```