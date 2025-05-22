---
title: Managing AWS S3 AccessGrantsLocations with Alchemy
description: Learn how to create, update, and manage AWS S3 AccessGrantsLocations using Alchemy Cloud Control.
---

# AccessGrantsLocation

The AccessGrantsLocation resource lets you create and manage [AWS S3 AccessGrantsLocations](https://docs.aws.amazon.com/s3/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-s3-accessgrantslocation.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const accessgrantslocation = await AWS.S3.AccessGrantsLocation("accessgrantslocation-example", {
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a accessgrantslocation with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedAccessGrantsLocation = await AWS.S3.AccessGrantsLocation(
  "advanced-accessgrantslocation",
  {
    Tags: {
      Environment: "production",
      Team: "DevOps",
      Project: "MyApp",
      CostCenter: "Engineering",
      ManagedBy: "Alchemy",
    },
  }
);
```

