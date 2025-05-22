---
title: Managing AWS RDS DBSubnetGroups with Alchemy
description: Learn how to create, update, and manage AWS RDS DBSubnetGroups using Alchemy Cloud Control.
---

# DBSubnetGroup

The DBSubnetGroup resource lets you create and manage [AWS RDS DBSubnetGroups](https://docs.aws.amazon.com/rds/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-rds-dbsubnetgroup.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const dbsubnetgroup = await AWS.RDS.DBSubnetGroup("dbsubnetgroup-example", {
  DBSubnetGroupDescription: "A dbsubnetgroup resource managed by Alchemy",
  SubnetIds: ["example-subnetids-1"],
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a dbsubnetgroup with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedDBSubnetGroup = await AWS.RDS.DBSubnetGroup("advanced-dbsubnetgroup", {
  DBSubnetGroupDescription: "A dbsubnetgroup resource managed by Alchemy",
  SubnetIds: ["example-subnetids-1"],
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

