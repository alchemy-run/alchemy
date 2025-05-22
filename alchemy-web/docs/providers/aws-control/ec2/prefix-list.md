---
title: Managing AWS EC2 PrefixLists with Alchemy
description: Learn how to create, update, and manage AWS EC2 PrefixLists using Alchemy Cloud Control.
---

# PrefixList

The PrefixList resource lets you create and manage [AWS EC2 PrefixLists](https://docs.aws.amazon.com/ec2/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ec2-prefixlist.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const prefixlist = await AWS.EC2.PrefixList("prefixlist-example", {
  PrefixListName: "prefixlist-prefixlist",
  AddressFamily: "example-addressfamily",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a prefixlist with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedPrefixList = await AWS.EC2.PrefixList("advanced-prefixlist", {
  PrefixListName: "prefixlist-prefixlist",
  AddressFamily: "example-addressfamily",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

