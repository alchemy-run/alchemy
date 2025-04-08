# Bucket

The Bucket component lets you add [Amazon S3 buckets](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html) to your app.

# Minimal Example

Create a basic S3 bucket with default settings.

```ts
import { Bucket } from "alchemy/aws";

const bucket = await Bucket("storage", {
  bucketName: "my-app-storage",
  tags: {
    Environment: "production"
  }
});
```

# Create a Versioned Bucket

Create a bucket with versioning enabled and specific tags.

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