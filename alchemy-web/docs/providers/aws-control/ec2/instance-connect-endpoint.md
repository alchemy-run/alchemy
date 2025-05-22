---
title: Managing AWS EC2 InstanceConnectEndpoints with Alchemy
description: Learn how to create, update, and manage AWS EC2 InstanceConnectEndpoints using Alchemy Cloud Control.
---

# InstanceConnectEndpoint

The InstanceConnectEndpoint resource lets you create and manage [AWS EC2 InstanceConnectEndpoints](https://docs.aws.amazon.com/ec2/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ec2-instanceconnectendpoint.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const instanceconnectendpoint = await AWS.EC2.InstanceConnectEndpoint(
  "instanceconnectendpoint-example",
  { SubnetId: "example-subnetid", Tags: { Environment: "production", ManagedBy: "Alchemy" } }
);
```

## Advanced Configuration

Create a instanceconnectendpoint with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedInstanceConnectEndpoint = await AWS.EC2.InstanceConnectEndpoint(
  "advanced-instanceconnectendpoint",
  {
    SubnetId: "example-subnetid",
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

