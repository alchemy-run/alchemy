---
title: Managing AWS GameLift Aliass with Alchemy
description: Learn how to create, update, and manage AWS GameLift Aliass using Alchemy Cloud Control.
---

# Alias

The Alias resource lets you create and manage [AWS GameLift Aliass](https://docs.aws.amazon.com/gamelift/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-gamelift-alias.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const alias = await AWS.GameLift.Alias("alias-example", {
  RoutingStrategy: "example-routingstrategy",
  Name: "alias-",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A alias resource managed by Alchemy",
});
```

## Advanced Configuration

Create a alias with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedAlias = await AWS.GameLift.Alias("advanced-alias", {
  RoutingStrategy: "example-routingstrategy",
  Name: "alias-",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A alias resource managed by Alchemy",
});
```

