---
title: Managing AWS Connect UserHierarchyGroups with Alchemy
description: Learn how to create, update, and manage AWS Connect UserHierarchyGroups using Alchemy Cloud Control.
---

# UserHierarchyGroup

The UserHierarchyGroup resource lets you create and manage [AWS Connect UserHierarchyGroups](https://docs.aws.amazon.com/connect/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-connect-userhierarchygroup.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const userhierarchygroup = await AWS.Connect.UserHierarchyGroup("userhierarchygroup-example", {
  InstanceArn: "example-instancearn",
  Name: "userhierarchygroup-",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a userhierarchygroup with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedUserHierarchyGroup = await AWS.Connect.UserHierarchyGroup(
  "advanced-userhierarchygroup",
  {
    InstanceArn: "example-instancearn",
    Name: "userhierarchygroup-",
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

