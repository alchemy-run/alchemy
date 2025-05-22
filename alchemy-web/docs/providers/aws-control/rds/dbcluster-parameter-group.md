---
title: Managing AWS RDS DBClusterParameterGroups with Alchemy
description: Learn how to create, update, and manage AWS RDS DBClusterParameterGroups using Alchemy Cloud Control.
---

# DBClusterParameterGroup

The DBClusterParameterGroup resource lets you create and manage [AWS RDS DBClusterParameterGroups](https://docs.aws.amazon.com/rds/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-rds-dbclusterparametergroup.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const dbclusterparametergroup = await AWS.RDS.DBClusterParameterGroup(
  "dbclusterparametergroup-example",
  {
    Description: "A dbclusterparametergroup resource managed by Alchemy",
    Parameters: {},
    Family: "example-family",
    Tags: { Environment: "production", ManagedBy: "Alchemy" },
  }
);
```

## Advanced Configuration

Create a dbclusterparametergroup with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedDBClusterParameterGroup = await AWS.RDS.DBClusterParameterGroup(
  "advanced-dbclusterparametergroup",
  {
    Description: "A dbclusterparametergroup resource managed by Alchemy",
    Parameters: {},
    Family: "example-family",
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

