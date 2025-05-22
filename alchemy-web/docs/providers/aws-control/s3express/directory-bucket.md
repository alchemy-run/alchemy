---
title: Managing AWS S3Express DirectoryBuckets with Alchemy
description: Learn how to create, update, and manage AWS S3Express DirectoryBuckets using Alchemy Cloud Control.
---

# DirectoryBucket

The DirectoryBucket resource lets you create and manage [AWS S3Express DirectoryBuckets](https://docs.aws.amazon.com/s3express/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-s3express-directorybucket.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const directorybucket = await AWS.S3Express.DirectoryBucket("directorybucket-example", {
  DataRedundancy: "example-dataredundancy",
  LocationName: "directorybucket-location",
});
```

