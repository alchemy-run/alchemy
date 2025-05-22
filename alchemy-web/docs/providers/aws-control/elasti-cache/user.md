---
title: Managing AWS ElastiCache Users with Alchemy
description: Learn how to create, update, and manage AWS ElastiCache Users using Alchemy Cloud Control.
---

# User

The User resource lets you create and manage [AWS ElastiCache Users](https://docs.aws.amazon.com/elasticache/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-elasticache-user.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const user = await AWS.ElastiCache.User("user-example", {
  UserName: "user-user",
  UserId: "example-userid",
  Engine: "example-engine",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a user with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedUser = await AWS.ElastiCache.User("advanced-user", {
  UserName: "user-user",
  UserId: "example-userid",
  Engine: "example-engine",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

