---
title: Managing AWS DataSync LocationFSxLustres with Alchemy
description: Learn how to create, update, and manage AWS DataSync LocationFSxLustres using Alchemy Cloud Control.
---

# LocationFSxLustre

The LocationFSxLustre resource lets you create and manage [AWS DataSync LocationFSxLustres](https://docs.aws.amazon.com/datasync/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-datasync-locationfsxlustre.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const locationfsxlustre = await AWS.DataSync.LocationFSxLustre("locationfsxlustre-example", {
  SecurityGroupArns: ["example-securitygrouparns-1"],
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a locationfsxlustre with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedLocationFSxLustre = await AWS.DataSync.LocationFSxLustre(
  "advanced-locationfsxlustre",
  {
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

