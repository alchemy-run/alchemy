---
title: Managing AWS EC2 TransitGateways with Alchemy
description: Learn how to create, update, and manage AWS EC2 TransitGateways using Alchemy Cloud Control.
---

# TransitGateway

The TransitGateway resource lets you create and manage [AWS EC2 TransitGateways](https://docs.aws.amazon.com/ec2/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ec2-transitgateway.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const transitgateway = await AWS.EC2.TransitGateway("transitgateway-example", {
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A transitgateway resource managed by Alchemy",
});
```

## Advanced Configuration

Create a transitgateway with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedTransitGateway = await AWS.EC2.TransitGateway("advanced-transitgateway", {
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A transitgateway resource managed by Alchemy",
});
```

