---
title: Managing AWS CodeStarConnections Connections with Alchemy
description: Learn how to create, update, and manage AWS CodeStarConnections Connections using Alchemy Cloud Control.
---

# Connection

The Connection resource lets you create and manage [AWS CodeStarConnections Connections](https://docs.aws.amazon.com/codestarconnections/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-codestarconnections-connection.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const connection = await AWS.CodeStarConnections.Connection("connection-example", {
  ConnectionName: "connection-connection",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a connection with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedConnection = await AWS.CodeStarConnections.Connection("advanced-connection", {
  ConnectionName: "connection-connection",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

