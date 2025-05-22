---
title: Managing AWS EC2 CustomerGateways with Alchemy
description: Learn how to create, update, and manage AWS EC2 CustomerGateways using Alchemy Cloud Control.
---

# CustomerGateway

The CustomerGateway resource lets you create and manage [AWS EC2 CustomerGateways](https://docs.aws.amazon.com/ec2/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ec2-customergateway.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const customergateway = await AWS.EC2.CustomerGateway("customergateway-example", {
  Type: "example-type",
  IpAddress: "example-ipaddress",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a customergateway with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedCustomerGateway = await AWS.EC2.CustomerGateway("advanced-customergateway", {
  Type: "example-type",
  IpAddress: "example-ipaddress",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

