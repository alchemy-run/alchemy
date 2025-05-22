---
title: Managing AWS EC2 VPCCidrBlocks with Alchemy
description: Learn how to create, update, and manage AWS EC2 VPCCidrBlocks using Alchemy Cloud Control.
---

# VPCCidrBlock

The VPCCidrBlock resource lets you create and manage [AWS EC2 VPCCidrBlocks](https://docs.aws.amazon.com/ec2/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ec2-vpccidrblock.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const vpccidrblock = await AWS.EC2.VPCCidrBlock("vpccidrblock-example", { VpcId: "example-vpcid" });
```

