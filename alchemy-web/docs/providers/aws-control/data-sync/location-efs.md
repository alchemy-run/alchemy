---
title: Managing AWS DataSync LocationEFSs with Alchemy
description: Learn how to create, update, and manage AWS DataSync LocationEFSs using Alchemy Cloud Control.
---

# LocationEFS

The LocationEFS resource lets you create and manage [AWS DataSync LocationEFSs](https://docs.aws.amazon.com/datasync/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-datasync-locationefs.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const locationefs = await AWS.DataSync.LocationEFS("locationefs-example", {
  Ec2Config: "example-ec2config",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a locationefs with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedLocationEFS = await AWS.DataSync.LocationEFS("advanced-locationefs", {
  Ec2Config: "example-ec2config",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

