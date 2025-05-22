---
title: Managing AWS EC2 LocalGatewayRouteTableVPCAssociations with Alchemy
description: Learn how to create, update, and manage AWS EC2 LocalGatewayRouteTableVPCAssociations using Alchemy Cloud Control.
---

# LocalGatewayRouteTableVPCAssociation

The LocalGatewayRouteTableVPCAssociation resource lets you create and manage [AWS EC2 LocalGatewayRouteTableVPCAssociations](https://docs.aws.amazon.com/ec2/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ec2-localgatewayroutetablevpcassociation.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const localgatewayroutetablevpcassociation = await AWS.EC2.LocalGatewayRouteTableVPCAssociation(
  "localgatewayroutetablevpcassociation-example",
  {
    VpcId: "example-vpcid",
    LocalGatewayRouteTableId: "example-localgatewayroutetableid",
    Tags: { Environment: "production", ManagedBy: "Alchemy" },
  }
);
```

## Advanced Configuration

Create a localgatewayroutetablevpcassociation with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedLocalGatewayRouteTableVPCAssociation =
  await AWS.EC2.LocalGatewayRouteTableVPCAssociation(
    "advanced-localgatewayroutetablevpcassociation",
    {
      VpcId: "example-vpcid",
      LocalGatewayRouteTableId: "example-localgatewayroutetableid",
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

