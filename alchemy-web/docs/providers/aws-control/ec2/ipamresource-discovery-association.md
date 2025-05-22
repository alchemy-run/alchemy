---
title: Managing AWS EC2 IPAMResourceDiscoveryAssociations with Alchemy
description: Learn how to create, update, and manage AWS EC2 IPAMResourceDiscoveryAssociations using Alchemy Cloud Control.
---

# IPAMResourceDiscoveryAssociation

The IPAMResourceDiscoveryAssociation resource lets you create and manage [AWS EC2 IPAMResourceDiscoveryAssociations](https://docs.aws.amazon.com/ec2/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ec2-ipamresourcediscoveryassociation.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const ipamresourcediscoveryassociation = await AWS.EC2.IPAMResourceDiscoveryAssociation(
  "ipamresourcediscoveryassociation-example",
  {
    IpamId: "example-ipamid",
    IpamResourceDiscoveryId: "example-ipamresourcediscoveryid",
    Tags: { Environment: "production", ManagedBy: "Alchemy" },
  }
);
```

## Advanced Configuration

Create a ipamresourcediscoveryassociation with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedIPAMResourceDiscoveryAssociation = await AWS.EC2.IPAMResourceDiscoveryAssociation(
  "advanced-ipamresourcediscoveryassociation",
  {
    IpamId: "example-ipamid",
    IpamResourceDiscoveryId: "example-ipamresourcediscoveryid",
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

