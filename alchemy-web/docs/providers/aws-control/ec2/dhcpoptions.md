---
title: Managing AWS EC2 DHCPOptionss with Alchemy
description: Learn how to create, update, and manage AWS EC2 DHCPOptionss using Alchemy Cloud Control.
---

# DHCPOptions

The DHCPOptions resource lets you create and manage [AWS EC2 DHCPOptionss](https://docs.aws.amazon.com/ec2/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ec2-dhcpoptions.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const dhcpoptions = await AWS.EC2.DHCPOptions("dhcpoptions-example", {
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a dhcpoptions with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedDHCPOptions = await AWS.EC2.DHCPOptions("advanced-dhcpoptions", {
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

