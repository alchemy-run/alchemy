---
title: Managing AWS NetworkManager GlobalNetworks with Alchemy
description: Learn how to create, update, and manage AWS NetworkManager GlobalNetworks using Alchemy Cloud Control.
---

# GlobalNetwork

The GlobalNetwork resource lets you create and manage [AWS NetworkManager GlobalNetworks](https://docs.aws.amazon.com/networkmanager/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-networkmanager-globalnetwork.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const globalnetwork = await AWS.NetworkManager.GlobalNetwork("globalnetwork-example", {
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A globalnetwork resource managed by Alchemy",
});
```

## Advanced Configuration

Create a globalnetwork with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedGlobalNetwork = await AWS.NetworkManager.GlobalNetwork("advanced-globalnetwork", {
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A globalnetwork resource managed by Alchemy",
});
```

