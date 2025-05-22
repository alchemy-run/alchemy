---
title: Managing AWS MemoryDB MultiRegionClusters with Alchemy
description: Learn how to create, update, and manage AWS MemoryDB MultiRegionClusters using Alchemy Cloud Control.
---

# MultiRegionCluster

The MultiRegionCluster resource lets you create and manage [AWS MemoryDB MultiRegionClusters](https://docs.aws.amazon.com/memorydb/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-memorydb-multiregioncluster.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const multiregioncluster = await AWS.MemoryDB.MultiRegionCluster("multiregioncluster-example", {
  NodeType: "example-nodetype",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A multiregioncluster resource managed by Alchemy",
});
```

## Advanced Configuration

Create a multiregioncluster with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedMultiRegionCluster = await AWS.MemoryDB.MultiRegionCluster(
  "advanced-multiregioncluster",
  {
    NodeType: "example-nodetype",
    Tags: {
      Environment: "production",
      Team: "DevOps",
      Project: "MyApp",
      CostCenter: "Engineering",
      ManagedBy: "Alchemy",
    },
    Description: "A multiregioncluster resource managed by Alchemy",
  }
);
```

