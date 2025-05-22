---
title: Managing AWS EC2 SubnetCidrBlocks with Alchemy
description: Learn how to create, update, and manage AWS EC2 SubnetCidrBlocks using Alchemy Cloud Control.
---

# SubnetCidrBlock

The SubnetCidrBlock resource lets you create and manage [AWS EC2 SubnetCidrBlocks](https://docs.aws.amazon.com/ec2/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ec2-subnetcidrblock.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const subnetcidrblock = await AWS.EC2.SubnetCidrBlock("subnetcidrblock-example", {
  SubnetId: "example-subnetid",
});
```

