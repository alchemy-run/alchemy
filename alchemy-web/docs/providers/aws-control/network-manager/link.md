---
title: Managing AWS NetworkManager Links with Alchemy
description: Learn how to create, update, and manage AWS NetworkManager Links using Alchemy Cloud Control.
---

# Link

The Link resource lets you create and manage [AWS NetworkManager Links](https://docs.aws.amazon.com/networkmanager/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-networkmanager-link.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const link = await AWS.NetworkManager.Link("link-example", {
  SiteId: "example-siteid",
  GlobalNetworkId: "example-globalnetworkid",
  Bandwidth: "example-bandwidth",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A link resource managed by Alchemy",
});
```

## Advanced Configuration

Create a link with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedLink = await AWS.NetworkManager.Link("advanced-link", {
  SiteId: "example-siteid",
  GlobalNetworkId: "example-globalnetworkid",
  Bandwidth: "example-bandwidth",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A link resource managed by Alchemy",
});
```

