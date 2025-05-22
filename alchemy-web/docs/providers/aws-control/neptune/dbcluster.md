---
title: Managing AWS Neptune DBClusters with Alchemy
description: Learn how to create, update, and manage AWS Neptune DBClusters using Alchemy Cloud Control.
---

# DBCluster

The DBCluster resource lets you create and manage [AWS Neptune DBClusters](https://docs.aws.amazon.com/neptune/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-neptune-dbcluster.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const dbcluster = await AWS.Neptune.DBCluster("dbcluster-example", {
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a dbcluster with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedDBCluster = await AWS.Neptune.DBCluster("advanced-dbcluster", {
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

