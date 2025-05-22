---
title: Managing AWS DataSync Agents with Alchemy
description: Learn how to create, update, and manage AWS DataSync Agents using Alchemy Cloud Control.
---

# Agent

The Agent resource lets you create and manage [AWS DataSync Agents](https://docs.aws.amazon.com/datasync/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-datasync-agent.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const agent = await AWS.DataSync.Agent("agent-example", {
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a agent with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedAgent = await AWS.DataSync.Agent("advanced-agent", {
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

