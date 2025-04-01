# Bucket

The Bucket component allows you to create and manage [Amazon S3 buckets](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html) with support for versioning, tags, and regional configuration. S3 buckets provide scalable object storage for any type of data, with features like versioning, lifecycle policies, and fine-grained access control.

# Minimal Example

```ts
import { Bucket } from "alchemy/aws";

const basicBucket = await Bucket("my-app-storage", {
  bucketName: "my-app-storage",
  tags: {
    Environment: "production",
    Project: "my-app"
  }
});
```

# Create the Bucket

```ts
import { Bucket } from "alchemy/aws";

// Create a basic S3 bucket with default settings
const basicBucket = await Bucket("my-app-storage", {
  bucketName: "my-app-storage",
  tags: {
    Environment: "production",
    Project: "my-app"
  }
});

// Create a bucket with versioning enabled and specific tags
const versionedBucket = await Bucket("document-archive", {
  bucketName: "document-archive",
  tags: {
    Environment: "production",
    Purpose: "document-storage",
    Versioning: "enabled"
  }
});

// Create a development bucket with minimal configuration
const devBucket = await Bucket("dev-testing", {
  bucketName: "dev-testing",
  tags: {
    Environment: "development",
    Temporary: "true"
  }
});
```