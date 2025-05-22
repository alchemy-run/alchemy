---
title: Managing AWS DAX SubnetGroups with Alchemy
description: Learn how to create, update, and manage AWS DAX SubnetGroups using Alchemy Cloud Control.
---

# SubnetGroup

The SubnetGroup resource lets you create and manage [AWS DAX SubnetGroups](https://docs.aws.amazon.com/dax/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-dax-subnetgroup.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const subnetgroup = await AWS.DAX.SubnetGroup("subnetgroup-example", {
  SubnetIds: ["example-subnetids-1"],
  Description: "A subnetgroup resource managed by Alchemy",
});
```

## Advanced Configuration

Create a subnetgroup with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedSubnetGroup = await AWS.DAX.SubnetGroup("advanced-subnetgroup", {
  SubnetIds: ["example-subnetids-1"],
  Description: "A subnetgroup resource managed by Alchemy",
});
```

