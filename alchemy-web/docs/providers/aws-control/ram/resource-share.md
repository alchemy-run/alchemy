---
title: Managing AWS RAM ResourceShares with Alchemy
description: Learn how to create, update, and manage AWS RAM ResourceShares using Alchemy Cloud Control.
---

# ResourceShare

The ResourceShare resource lets you create and manage [AWS RAM ResourceShares](https://docs.aws.amazon.com/ram/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ram-resourceshare.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const resourceshare = await AWS.RAM.ResourceShare("resourceshare-example", {
  Name: "resourceshare-",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a resourceshare with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedResourceShare = await AWS.RAM.ResourceShare("advanced-resourceshare", {
  Name: "resourceshare-",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

