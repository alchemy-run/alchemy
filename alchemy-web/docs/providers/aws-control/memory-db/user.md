---
title: Managing AWS MemoryDB Users with Alchemy
description: Learn how to create, update, and manage AWS MemoryDB Users using Alchemy Cloud Control.
---

# User

The User resource lets you create and manage [AWS MemoryDB Users](https://docs.aws.amazon.com/memorydb/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-memorydb-user.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const user = await AWS.MemoryDB.User("user-example", {
  UserName: "user-user",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a user with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedUser = await AWS.MemoryDB.User("advanced-user", {
  UserName: "user-user",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

