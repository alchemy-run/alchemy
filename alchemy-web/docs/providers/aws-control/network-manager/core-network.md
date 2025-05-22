---
title: Managing AWS NetworkManager CoreNetworks with Alchemy
description: Learn how to create, update, and manage AWS NetworkManager CoreNetworks using Alchemy Cloud Control.
---

# CoreNetwork

The CoreNetwork resource lets you create and manage [AWS NetworkManager CoreNetworks](https://docs.aws.amazon.com/networkmanager/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-networkmanager-corenetwork.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const corenetwork = await AWS.NetworkManager.CoreNetwork("corenetwork-example", {
  GlobalNetworkId: "example-globalnetworkid",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A corenetwork resource managed by Alchemy",
});
```

## Advanced Configuration

Create a corenetwork with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedCoreNetwork = await AWS.NetworkManager.CoreNetwork("advanced-corenetwork", {
  GlobalNetworkId: "example-globalnetworkid",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A corenetwork resource managed by Alchemy",
});
```

