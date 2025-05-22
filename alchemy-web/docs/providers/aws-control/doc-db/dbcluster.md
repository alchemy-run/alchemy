---
title: Managing AWS DocDB DBClusters with Alchemy
description: Learn how to create, update, and manage AWS DocDB DBClusters using Alchemy Cloud Control.
---

# DBCluster

The DBCluster resource lets you create and manage [AWS DocDB DBClusters](https://docs.aws.amazon.com/docdb/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-docdb-dbcluster.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const dbcluster = await AWS.DocDB.DBCluster("dbcluster-example", {
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a dbcluster with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedDBCluster = await AWS.DocDB.DBCluster("advanced-dbcluster", {
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

