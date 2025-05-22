---
title: Managing AWS EC2 TransitGatewayMulticastDomainAssociations with Alchemy
description: Learn how to create, update, and manage AWS EC2 TransitGatewayMulticastDomainAssociations using Alchemy Cloud Control.
---

# TransitGatewayMulticastDomainAssociation

The TransitGatewayMulticastDomainAssociation resource lets you create and manage [AWS EC2 TransitGatewayMulticastDomainAssociations](https://docs.aws.amazon.com/ec2/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ec2-transitgatewaymulticastdomainassociation.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const transitgatewaymulticastdomainassociation =
  await AWS.EC2.TransitGatewayMulticastDomainAssociation(
    "transitgatewaymulticastdomainassociation-example",
    {
      TransitGatewayMulticastDomainId: "example-transitgatewaymulticastdomainid",
      SubnetId: "example-subnetid",
      TransitGatewayAttachmentId: "example-transitgatewayattachmentid",
    }
  );
```

