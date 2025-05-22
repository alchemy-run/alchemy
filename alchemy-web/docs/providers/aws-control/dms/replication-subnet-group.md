---
title: Managing AWS DMS ReplicationSubnetGroups with Alchemy
description: Learn how to create, update, and manage AWS DMS ReplicationSubnetGroups using Alchemy Cloud Control.
---

# ReplicationSubnetGroup

The ReplicationSubnetGroup resource lets you create and manage [AWS DMS ReplicationSubnetGroups](https://docs.aws.amazon.com/dms/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-dms-replicationsubnetgroup.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const replicationsubnetgroup = await AWS.DMS.ReplicationSubnetGroup(
  "replicationsubnetgroup-example",
  {
    ReplicationSubnetGroupDescription: "A replicationsubnetgroup resource managed by Alchemy",
    SubnetIds: ["example-subnetids-1"],
    Tags: { Environment: "production", ManagedBy: "Alchemy" },
  }
);
```

## Advanced Configuration

Create a replicationsubnetgroup with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedReplicationSubnetGroup = await AWS.DMS.ReplicationSubnetGroup(
  "advanced-replicationsubnetgroup",
  {
    ReplicationSubnetGroupDescription: "A replicationsubnetgroup resource managed by Alchemy",
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

