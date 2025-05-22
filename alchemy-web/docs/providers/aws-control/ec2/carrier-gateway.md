---
title: Managing AWS EC2 CarrierGateways with Alchemy
description: Learn how to create, update, and manage AWS EC2 CarrierGateways using Alchemy Cloud Control.
---

# CarrierGateway

The CarrierGateway resource lets you create and manage [AWS EC2 CarrierGateways](https://docs.aws.amazon.com/ec2/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ec2-carriergateway.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const carriergateway = await AWS.EC2.CarrierGateway("carriergateway-example", {
  VpcId: "example-vpcid",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a carriergateway with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedCarrierGateway = await AWS.EC2.CarrierGateway("advanced-carriergateway", {
  VpcId: "example-vpcid",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

