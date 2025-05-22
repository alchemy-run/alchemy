---
title: Managing AWS PinpointEmail DedicatedIpPools with Alchemy
description: Learn how to create, update, and manage AWS PinpointEmail DedicatedIpPools using Alchemy Cloud Control.
---

# DedicatedIpPool

The DedicatedIpPool resource lets you create and manage [AWS PinpointEmail DedicatedIpPools](https://docs.aws.amazon.com/pinpointemail/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-pinpointemail-dedicatedippool.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const dedicatedippool = await AWS.PinpointEmail.DedicatedIpPool("dedicatedippool-example", {
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a dedicatedippool with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedDedicatedIpPool = await AWS.PinpointEmail.DedicatedIpPool(
  "advanced-dedicatedippool",
  {
    Tags: {
      Environment: "production",
      Team: "DevOps",
      Project: "MyApp",
      CostCenter: "Engineering",
      ManagedBy: "Alchemy",
    },
  }
);
```

