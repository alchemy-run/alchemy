---
title: Managing AWS GameLift MatchmakingConfigurations with Alchemy
description: Learn how to create, update, and manage AWS GameLift MatchmakingConfigurations using Alchemy Cloud Control.
---

# MatchmakingConfiguration

The MatchmakingConfiguration resource lets you create and manage [AWS GameLift MatchmakingConfigurations](https://docs.aws.amazon.com/gamelift/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-gamelift-matchmakingconfiguration.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const matchmakingconfiguration = await AWS.GameLift.MatchmakingConfiguration(
  "matchmakingconfiguration-example",
  {
    Name: "matchmakingconfiguration-",
    RequestTimeoutSeconds: 1,
    AcceptanceRequired: true,
    RuleSetName: "matchmakingconfiguration-ruleset",
    Tags: { Environment: "production", ManagedBy: "Alchemy" },
    Description: "A matchmakingconfiguration resource managed by Alchemy",
  }
);
```

## Advanced Configuration

Create a matchmakingconfiguration with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedMatchmakingConfiguration = await AWS.GameLift.MatchmakingConfiguration(
  "advanced-matchmakingconfiguration",
  {
    Name: "matchmakingconfiguration-",
    RequestTimeoutSeconds: 1,
    AcceptanceRequired: true,
    RuleSetName: "matchmakingconfiguration-ruleset",
    Tags: {
      Environment: "production",
      Team: "DevOps",
      Project: "MyApp",
      CostCenter: "Engineering",
      ManagedBy: "Alchemy",
    },
    Description: "A matchmakingconfiguration resource managed by Alchemy",
  }
);
```

