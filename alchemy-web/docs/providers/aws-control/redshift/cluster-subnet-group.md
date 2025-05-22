---
title: Managing AWS Redshift ClusterSubnetGroups with Alchemy
description: Learn how to create, update, and manage AWS Redshift ClusterSubnetGroups using Alchemy Cloud Control.
---

# ClusterSubnetGroup

The ClusterSubnetGroup resource lets you create and manage [AWS Redshift ClusterSubnetGroups](https://docs.aws.amazon.com/redshift/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-redshift-clustersubnetgroup.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const clustersubnetgroup = await AWS.Redshift.ClusterSubnetGroup("clustersubnetgroup-example", {
  Description: "A clustersubnetgroup resource managed by Alchemy",
  SubnetIds: ["example-subnetids-1"],
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a clustersubnetgroup with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedClusterSubnetGroup = await AWS.Redshift.ClusterSubnetGroup(
  "advanced-clustersubnetgroup",
  {
    Description: "A clustersubnetgroup resource managed by Alchemy",
    SubnetIds: ["example-subnetids-1"],
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

