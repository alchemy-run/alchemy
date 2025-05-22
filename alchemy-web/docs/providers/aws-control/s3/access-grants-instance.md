---
title: Managing AWS S3 AccessGrantsInstances with Alchemy
description: Learn how to create, update, and manage AWS S3 AccessGrantsInstances using Alchemy Cloud Control.
---

# AccessGrantsInstance

The AccessGrantsInstance resource lets you create and manage [AWS S3 AccessGrantsInstances](https://docs.aws.amazon.com/s3/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-s3-accessgrantsinstance.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const accessgrantsinstance = await AWS.S3.AccessGrantsInstance("accessgrantsinstance-example", {
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a accessgrantsinstance with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedAccessGrantsInstance = await AWS.S3.AccessGrantsInstance(
  "advanced-accessgrantsinstance",
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

