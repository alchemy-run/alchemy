---
title: Managing AWS GameLift Builds with Alchemy
description: Learn how to create, update, and manage AWS GameLift Builds using Alchemy Cloud Control.
---

# Build

The Build resource lets you create and manage [AWS GameLift Builds](https://docs.aws.amazon.com/gamelift/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-gamelift-build.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const build = await AWS.GameLift.Build("build-example", {
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a build with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedBuild = await AWS.GameLift.Build("advanced-build", {
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

