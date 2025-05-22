---
title: Managing AWS NetworkFirewall Firewalls with Alchemy
description: Learn how to create, update, and manage AWS NetworkFirewall Firewalls using Alchemy Cloud Control.
---

# Firewall

The Firewall resource lets you create and manage [AWS NetworkFirewall Firewalls](https://docs.aws.amazon.com/networkfirewall/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-networkfirewall-firewall.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const firewall = await AWS.NetworkFirewall.Firewall("firewall-example", {
  FirewallPolicyArn: "example-firewallpolicyarn",
  FirewallName: "firewall-firewall",
  VpcId: "example-vpcid",
  SubnetMappings: [],
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A firewall resource managed by Alchemy",
});
```

## Advanced Configuration

Create a firewall with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedFirewall = await AWS.NetworkFirewall.Firewall("advanced-firewall", {
  FirewallPolicyArn: "example-firewallpolicyarn",
  FirewallName: "firewall-firewall",
  VpcId: "example-vpcid",
  SubnetMappings: [],
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A firewall resource managed by Alchemy",
});
```

