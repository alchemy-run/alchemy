---
title: Managing AWS EC2 VPCBlockPublicAccessExclusions with Alchemy
description: Learn how to create, update, and manage AWS EC2 VPCBlockPublicAccessExclusions using Alchemy Cloud Control.
---

# VPCBlockPublicAccessExclusion

The VPCBlockPublicAccessExclusion resource lets you create and manage [AWS EC2 VPCBlockPublicAccessExclusions](https://docs.aws.amazon.com/ec2/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ec2-vpcblockpublicaccessexclusion.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const vpcblockpublicaccessexclusion = await AWS.EC2.VPCBlockPublicAccessExclusion(
  "vpcblockpublicaccessexclusion-example",
  {
    InternetGatewayExclusionMode: "example-internetgatewayexclusionmode",
    Tags: { Environment: "production", ManagedBy: "Alchemy" },
  }
);
```

## Advanced Configuration

Create a vpcblockpublicaccessexclusion with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedVPCBlockPublicAccessExclusion = await AWS.EC2.VPCBlockPublicAccessExclusion(
  "advanced-vpcblockpublicaccessexclusion",
  {
    InternetGatewayExclusionMode: "example-internetgatewayexclusionmode",
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

