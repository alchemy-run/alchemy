---
title: Managing AWS VpcLattice ResourceGateways with Alchemy
description: Learn how to create, update, and manage AWS VpcLattice ResourceGateways using Alchemy Cloud Control.
---

# ResourceGateway

The ResourceGateway resource lets you create and manage [AWS VpcLattice ResourceGateways](https://docs.aws.amazon.com/vpclattice/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-vpclattice-resourcegateway.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const resourcegateway = await AWS.VpcLattice.ResourceGateway("resourcegateway-example", {
  VpcIdentifier: "example-vpcidentifier",
  SubnetIds: ["example-subnetids-1"],
  Name: "resourcegateway-",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a resourcegateway with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedResourceGateway = await AWS.VpcLattice.ResourceGateway("advanced-resourcegateway", {
  VpcIdentifier: "example-vpcidentifier",
  SubnetIds: ["example-subnetids-1"],
  Name: "resourcegateway-",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

