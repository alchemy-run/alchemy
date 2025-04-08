# AWS S3 Bucket

The [S3 Bucket](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html) resource creates and manages Amazon S3 buckets for scalable object storage.

# Minimal Example

Create a basic S3 bucket with default settings:

```ts
import { Bucket } from "alchemy/aws";

const bucket = await Bucket("my-bucket", {
  bucketName: "my-app-storage",
  tags: {
    Environment: "production"
  }
});
```

# Create a Versioned Bucket

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

# Create a Development Bucket

Create a bucket for development/testing:

```ts
import { Bucket } from "alchemy/aws";

const devBucket = await Bucket("dev-testing", {
  bucketName: "dev-testing",
  tags: {
    Environment: "development",
    Temporary: "true"
  }
});