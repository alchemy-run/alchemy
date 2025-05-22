---
title: Managing AWS NetworkManager Sites with Alchemy
description: Learn how to create, update, and manage AWS NetworkManager Sites using Alchemy Cloud Control.
---

# Site

The Site resource lets you create and manage [AWS NetworkManager Sites](https://docs.aws.amazon.com/networkmanager/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-networkmanager-site.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const site = await AWS.NetworkManager.Site("site-example", {
  GlobalNetworkId: "example-globalnetworkid",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A site resource managed by Alchemy",
});
```

## Advanced Configuration

Create a site with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedSite = await AWS.NetworkManager.Site("advanced-site", {
  GlobalNetworkId: "example-globalnetworkid",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A site resource managed by Alchemy",
});
```

