---
title: Managing AWS Transfer Users with Alchemy
description: Learn how to create, update, and manage AWS Transfer Users using Alchemy Cloud Control.
---

# User

The User resource lets you create and manage [AWS Transfer Users](https://docs.aws.amazon.com/transfer/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-transfer-user.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const user = await AWS.Transfer.User("user-example", {
  Role: "example-role",
  ServerId: "example-serverid",
  UserName: "user-user",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a user with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedUser = await AWS.Transfer.User("advanced-user", {
  Role: "example-role",
  ServerId: "example-serverid",
  UserName: "user-user",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Policy: {
    Version: "2012-10-17",
    Statement: [{ Effect: "Allow", Action: ["s3:GetObject"], Resource: "*" }],
  },
});
```

