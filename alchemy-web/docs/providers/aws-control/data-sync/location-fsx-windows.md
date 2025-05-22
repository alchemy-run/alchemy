---
title: Managing AWS DataSync LocationFSxWindowss with Alchemy
description: Learn how to create, update, and manage AWS DataSync LocationFSxWindowss using Alchemy Cloud Control.
---

# LocationFSxWindows

The LocationFSxWindows resource lets you create and manage [AWS DataSync LocationFSxWindowss](https://docs.aws.amazon.com/datasync/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-datasync-locationfsxwindows.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const locationfsxwindows = await AWS.DataSync.LocationFSxWindows("locationfsxwindows-example", {
  User: "example-user",
  SecurityGroupArns: ["example-securitygrouparns-1"],
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a locationfsxwindows with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedLocationFSxWindows = await AWS.DataSync.LocationFSxWindows(
  "advanced-locationfsxwindows",
  {
    User: "example-user",
    SecurityGroupArns: ["example-securitygrouparns-1"],
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

