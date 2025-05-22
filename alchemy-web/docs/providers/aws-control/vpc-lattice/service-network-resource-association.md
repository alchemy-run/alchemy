---
title: Managing AWS VpcLattice ServiceNetworkResourceAssociations with Alchemy
description: Learn how to create, update, and manage AWS VpcLattice ServiceNetworkResourceAssociations using Alchemy Cloud Control.
---

# ServiceNetworkResourceAssociation

The ServiceNetworkResourceAssociation resource lets you create and manage [AWS VpcLattice ServiceNetworkResourceAssociations](https://docs.aws.amazon.com/vpclattice/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-vpclattice-servicenetworkresourceassociation.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const servicenetworkresourceassociation = await AWS.VpcLattice.ServiceNetworkResourceAssociation(
  "servicenetworkresourceassociation-example",
  { Tags: { Environment: "production", ManagedBy: "Alchemy" } }
);
```

## Advanced Configuration

Create a servicenetworkresourceassociation with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedServiceNetworkResourceAssociation =
  await AWS.VpcLattice.ServiceNetworkResourceAssociation(
    "advanced-servicenetworkresourceassociation",
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

