---
title: Managing AWS EC2 IPAMScopes with Alchemy
description: Learn how to create, update, and manage AWS EC2 IPAMScopes using Alchemy Cloud Control.
---

# IPAMScope

The IPAMScope resource lets you create and manage [AWS EC2 IPAMScopes](https://docs.aws.amazon.com/ec2/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ec2-ipamscope.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const ipamscope = await AWS.EC2.IPAMScope("ipamscope-example", {
  IpamId: "example-ipamid",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A ipamscope resource managed by Alchemy",
});
```

## Advanced Configuration

Create a ipamscope with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedIPAMScope = await AWS.EC2.IPAMScope("advanced-ipamscope", {
  IpamId: "example-ipamid",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A ipamscope resource managed by Alchemy",
});
```

