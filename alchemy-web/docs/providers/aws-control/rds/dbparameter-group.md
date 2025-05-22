---
title: Managing AWS RDS DBParameterGroups with Alchemy
description: Learn how to create, update, and manage AWS RDS DBParameterGroups using Alchemy Cloud Control.
---

# DBParameterGroup

The DBParameterGroup resource lets you create and manage [AWS RDS DBParameterGroups](https://docs.aws.amazon.com/rds/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-rds-dbparametergroup.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const dbparametergroup = await AWS.RDS.DBParameterGroup("dbparametergroup-example", {
  Description: "A dbparametergroup resource managed by Alchemy",
  Family: "example-family",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a dbparametergroup with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedDBParameterGroup = await AWS.RDS.DBParameterGroup("advanced-dbparametergroup", {
  Description: "A dbparametergroup resource managed by Alchemy",
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

