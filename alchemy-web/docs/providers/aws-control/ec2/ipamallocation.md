---
title: Managing AWS EC2 IPAMAllocations with Alchemy
description: Learn how to create, update, and manage AWS EC2 IPAMAllocations using Alchemy Cloud Control.
---

# IPAMAllocation

The IPAMAllocation resource lets you create and manage [AWS EC2 IPAMAllocations](https://docs.aws.amazon.com/ec2/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ec2-ipamallocation.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const ipamallocation = await AWS.EC2.IPAMAllocation("ipamallocation-example", {
  IpamPoolId: "example-ipampoolid",
  Description: "A ipamallocation resource managed by Alchemy",
});
```

## Advanced Configuration

Create a ipamallocation with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedIPAMAllocation = await AWS.EC2.IPAMAllocation("advanced-ipamallocation", {
  IpamPoolId: "example-ipampoolid",
  Description: "A ipamallocation resource managed by Alchemy",
});
```

