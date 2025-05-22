---
title: Managing AWS CloudTrail Trails with Alchemy
description: Learn how to create, update, and manage AWS CloudTrail Trails using Alchemy Cloud Control.
---

# Trail

The Trail resource lets you create and manage [AWS CloudTrail Trails](https://docs.aws.amazon.com/cloudtrail/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-cloudtrail-trail.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const trail = await AWS.CloudTrail.Trail("trail-example", {
  S3BucketName: "trail-s3bucket",
  IsLogging: true,
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a trail with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedTrail = await AWS.CloudTrail.Trail("advanced-trail", {
  S3BucketName: "trail-s3bucket",
  IsLogging: true,
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

