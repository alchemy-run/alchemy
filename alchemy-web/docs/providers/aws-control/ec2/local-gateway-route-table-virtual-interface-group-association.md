---
title: Managing AWS EC2 LocalGatewayRouteTableVirtualInterfaceGroupAssociations with Alchemy
description: Learn how to create, update, and manage AWS EC2 LocalGatewayRouteTableVirtualInterfaceGroupAssociations using Alchemy Cloud Control.
---

# LocalGatewayRouteTableVirtualInterfaceGroupAssociation

The LocalGatewayRouteTableVirtualInterfaceGroupAssociation resource lets you create and manage [AWS EC2 LocalGatewayRouteTableVirtualInterfaceGroupAssociations](https://docs.aws.amazon.com/ec2/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ec2-localgatewayroutetablevirtualinterfacegroupassociation.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const localgatewayroutetablevirtualinterfacegroupassociation =
  await AWS.EC2.LocalGatewayRouteTableVirtualInterfaceGroupAssociation(
    "localgatewayroutetablevirtualinterfacegroupassociation-example",
    {
      LocalGatewayRouteTableId: "example-localgatewayroutetableid",
      LocalGatewayVirtualInterfaceGroupId: "example-localgatewayvirtualinterfacegroupid",
      Tags: { Environment: "production", ManagedBy: "Alchemy" },
    }
  );
```

## Advanced Configuration

Create a localgatewayroutetablevirtualinterfacegroupassociation with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedLocalGatewayRouteTableVirtualInterfaceGroupAssociation =
  await AWS.EC2.LocalGatewayRouteTableVirtualInterfaceGroupAssociation(
    "advanced-localgatewayroutetablevirtualinterfacegroupassociation",
    {
      LocalGatewayRouteTableId: "example-localgatewayroutetableid",
      LocalGatewayVirtualInterfaceGroupId: "example-localgatewayvirtualinterfacegroupid",
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

