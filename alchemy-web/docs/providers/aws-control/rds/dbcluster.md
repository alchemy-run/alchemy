---
title: Managing AWS RDS DBClusters with Alchemy
description: Learn how to create, update, and manage AWS RDS DBClusters using Alchemy Cloud Control.
---

# DBCluster

The DBCluster resource lets you create and manage [AWS RDS DBClusters](https://docs.aws.amazon.com/rds/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-rds-dbcluster.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const dbcluster = await AWS.RDS.DBCluster("dbcluster-example", {
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a dbcluster with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedDBCluster = await AWS.RDS.DBCluster("advanced-dbcluster", {
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

