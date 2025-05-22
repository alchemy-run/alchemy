---
title: Managing AWS Deadline LicenseEndpoints with Alchemy
description: Learn how to create, update, and manage AWS Deadline LicenseEndpoints using Alchemy Cloud Control.
---

# LicenseEndpoint

The LicenseEndpoint resource lets you create and manage [AWS Deadline LicenseEndpoints](https://docs.aws.amazon.com/deadline/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-deadline-licenseendpoint.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const licenseendpoint = await AWS.Deadline.LicenseEndpoint("licenseendpoint-example", {
  VpcId: "example-vpcid",
  SecurityGroupIds: ["example-securitygroupids-1"],
  SubnetIds: ["example-subnetids-1"],
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a licenseendpoint with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedLicenseEndpoint = await AWS.Deadline.LicenseEndpoint("advanced-licenseendpoint", {
  VpcId: "example-vpcid",
  SecurityGroupIds: ["example-securitygroupids-1"],
  SubnetIds: ["example-subnetids-1"],
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

