---
title: Managing AWS DMS InstanceProfiles with Alchemy
description: Learn how to create, update, and manage AWS DMS InstanceProfiles using Alchemy Cloud Control.
---

# InstanceProfile

The InstanceProfile resource lets you create and manage [AWS DMS InstanceProfiles](https://docs.aws.amazon.com/dms/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-dms-instanceprofile.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const instanceprofile = await AWS.DMS.InstanceProfile("instanceprofile-example", {
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A instanceprofile resource managed by Alchemy",
});
```

## Advanced Configuration

Create a instanceprofile with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedInstanceProfile = await AWS.DMS.InstanceProfile("advanced-instanceprofile", {
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A instanceprofile resource managed by Alchemy",
});
```

