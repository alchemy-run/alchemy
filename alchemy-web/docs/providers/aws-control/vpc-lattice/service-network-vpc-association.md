---
title: Managing AWS VpcLattice ServiceNetworkVpcAssociations with Alchemy
description: Learn how to create, update, and manage AWS VpcLattice ServiceNetworkVpcAssociations using Alchemy Cloud Control.
---

# ServiceNetworkVpcAssociation

The ServiceNetworkVpcAssociation resource lets you create and manage [AWS VpcLattice ServiceNetworkVpcAssociations](https://docs.aws.amazon.com/vpclattice/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-vpclattice-servicenetworkvpcassociation.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const servicenetworkvpcassociation = await AWS.VpcLattice.ServiceNetworkVpcAssociation(
  "servicenetworkvpcassociation-example",
  { Tags: { Environment: "production", ManagedBy: "Alchemy" } }
);
```

## Advanced Configuration

Create a servicenetworkvpcassociation with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedServiceNetworkVpcAssociation = await AWS.VpcLattice.ServiceNetworkVpcAssociation(
  "advanced-servicenetworkvpcassociation",
  {
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

