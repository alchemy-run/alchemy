---
title: Managing AWS Neptune DBParameterGroups with Alchemy
description: Learn how to create, update, and manage AWS Neptune DBParameterGroups using Alchemy Cloud Control.
---

# DBParameterGroup

The DBParameterGroup resource lets you create and manage [AWS Neptune DBParameterGroups](https://docs.aws.amazon.com/neptune/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-neptune-dbparametergroup.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const dbparametergroup = await AWS.Neptune.DBParameterGroup("dbparametergroup-example", {
  Description: "A dbparametergroup resource managed by Alchemy",
  Parameters: {},
  Family: "example-family",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a dbparametergroup with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedDBParameterGroup = await AWS.Neptune.DBParameterGroup("advanced-dbparametergroup", {
  Description: "A dbparametergroup resource managed by Alchemy",
  Parameters: {},
  Family: "example-family",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

