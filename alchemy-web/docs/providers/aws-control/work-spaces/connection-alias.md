---
title: Managing AWS WorkSpaces ConnectionAliass with Alchemy
description: Learn how to create, update, and manage AWS WorkSpaces ConnectionAliass using Alchemy Cloud Control.
---

# ConnectionAlias

The ConnectionAlias resource lets you create and manage [AWS WorkSpaces ConnectionAliass](https://docs.aws.amazon.com/workspaces/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-workspaces-connectionalias.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const connectionalias = await AWS.WorkSpaces.ConnectionAlias("connectionalias-example", {
  ConnectionString: "example-connectionstring",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a connectionalias with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedConnectionAlias = await AWS.WorkSpaces.ConnectionAlias("advanced-connectionalias", {
  ConnectionString: "example-connectionstring",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

