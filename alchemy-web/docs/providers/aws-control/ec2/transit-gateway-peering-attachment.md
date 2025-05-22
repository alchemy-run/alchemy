---
title: Managing AWS EC2 TransitGatewayPeeringAttachments with Alchemy
description: Learn how to create, update, and manage AWS EC2 TransitGatewayPeeringAttachments using Alchemy Cloud Control.
---

# TransitGatewayPeeringAttachment

The TransitGatewayPeeringAttachment resource lets you create and manage [AWS EC2 TransitGatewayPeeringAttachments](https://docs.aws.amazon.com/ec2/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ec2-transitgatewaypeeringattachment.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const transitgatewaypeeringattachment = await AWS.EC2.TransitGatewayPeeringAttachment(
  "transitgatewaypeeringattachment-example",
  {
    TransitGatewayId: "example-transitgatewayid",
    PeerTransitGatewayId: "example-peertransitgatewayid",
    PeerAccountId: "example-peeraccountid",
    PeerRegion: "example-peerregion",
    Tags: { Environment: "production", ManagedBy: "Alchemy" },
  }
);
```

## Advanced Configuration

Create a transitgatewaypeeringattachment with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedTransitGatewayPeeringAttachment = await AWS.EC2.TransitGatewayPeeringAttachment(
  "advanced-transitgatewaypeeringattachment",
  {
    TransitGatewayId: "example-transitgatewayid",
    PeerTransitGatewayId: "example-peertransitgatewayid",
    PeerAccountId: "example-peeraccountid",
    PeerRegion: "example-peerregion",
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

