---
title: Managing AWS Proton EnvironmentAccountConnections with Alchemy
description: Learn how to create, update, and manage AWS Proton EnvironmentAccountConnections using Alchemy Cloud Control.
---

# EnvironmentAccountConnection

The EnvironmentAccountConnection resource lets you create and manage [AWS Proton EnvironmentAccountConnections](https://docs.aws.amazon.com/proton/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-proton-environmentaccountconnection.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const environmentaccountconnection = await AWS.Proton.EnvironmentAccountConnection(
  "environmentaccountconnection-example",
  { Tags: { Environment: "production", ManagedBy: "Alchemy" } }
);
```

## Advanced Configuration

Create a environmentaccountconnection with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedEnvironmentAccountConnection = await AWS.Proton.EnvironmentAccountConnection(
  "advanced-environmentaccountconnection",
  {
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

