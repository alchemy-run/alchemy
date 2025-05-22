---
title: Managing AWS MemoryDB SubnetGroups with Alchemy
description: Learn how to create, update, and manage AWS MemoryDB SubnetGroups using Alchemy Cloud Control.
---

# SubnetGroup

The SubnetGroup resource lets you create and manage [AWS MemoryDB SubnetGroups](https://docs.aws.amazon.com/memorydb/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-memorydb-subnetgroup.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const subnetgroup = await AWS.MemoryDB.SubnetGroup("subnetgroup-example", {
  SubnetGroupName: "subnetgroup-subnetgroup",
  SubnetIds: ["example-subnetids-1"],
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A subnetgroup resource managed by Alchemy",
});
```

## Advanced Configuration

Create a subnetgroup with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedSubnetGroup = await AWS.MemoryDB.SubnetGroup("advanced-subnetgroup", {
  SubnetGroupName: "subnetgroup-subnetgroup",
  SubnetIds: ["example-subnetids-1"],
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A subnetgroup resource managed by Alchemy",
});
```

