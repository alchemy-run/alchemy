---
title: Managing AWS ElastiCache UserGroups with Alchemy
description: Learn how to create, update, and manage AWS ElastiCache UserGroups using Alchemy Cloud Control.
---

# UserGroup

The UserGroup resource lets you create and manage [AWS ElastiCache UserGroups](https://docs.aws.amazon.com/elasticache/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-elasticache-usergroup.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const usergroup = await AWS.ElastiCache.UserGroup("usergroup-example", {
  UserGroupId: "example-usergroupid",
  Engine: "example-engine",
  UserIds: ["example-userids-1"],
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a usergroup with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedUserGroup = await AWS.ElastiCache.UserGroup("advanced-usergroup", {
  UserGroupId: "example-usergroupid",
  Engine: "example-engine",
  UserIds: ["example-userids-1"],
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

