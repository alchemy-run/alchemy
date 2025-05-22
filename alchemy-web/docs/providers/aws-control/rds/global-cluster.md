---
title: Managing AWS RDS GlobalClusters with Alchemy
description: Learn how to create, update, and manage AWS RDS GlobalClusters using Alchemy Cloud Control.
---

# GlobalCluster

The GlobalCluster resource lets you create and manage [AWS RDS GlobalClusters](https://docs.aws.amazon.com/rds/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-rds-globalcluster.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const globalcluster = await AWS.RDS.GlobalCluster("globalcluster-example", {
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a globalcluster with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedGlobalCluster = await AWS.RDS.GlobalCluster("advanced-globalcluster", {
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

