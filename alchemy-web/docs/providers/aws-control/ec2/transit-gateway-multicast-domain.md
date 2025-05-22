---
title: Managing AWS EC2 TransitGatewayMulticastDomains with Alchemy
description: Learn how to create, update, and manage AWS EC2 TransitGatewayMulticastDomains using Alchemy Cloud Control.
---

# TransitGatewayMulticastDomain

The TransitGatewayMulticastDomain resource lets you create and manage [AWS EC2 TransitGatewayMulticastDomains](https://docs.aws.amazon.com/ec2/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ec2-transitgatewaymulticastdomain.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const transitgatewaymulticastdomain = await AWS.EC2.TransitGatewayMulticastDomain(
  "transitgatewaymulticastdomain-example",
  {
    TransitGatewayId: "example-transitgatewayid",
    Tags: { Environment: "production", ManagedBy: "Alchemy" },
  }
);
```

## Advanced Configuration

Create a transitgatewaymulticastdomain with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedTransitGatewayMulticastDomain = await AWS.EC2.TransitGatewayMulticastDomain(
  "advanced-transitgatewaymulticastdomain",
  {
    TransitGatewayId: "example-transitgatewayid",
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

