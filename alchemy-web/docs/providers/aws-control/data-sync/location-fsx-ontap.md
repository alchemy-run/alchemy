---
title: Managing AWS DataSync LocationFSxONTAPs with Alchemy
description: Learn how to create, update, and manage AWS DataSync LocationFSxONTAPs using Alchemy Cloud Control.
---

# LocationFSxONTAP

The LocationFSxONTAP resource lets you create and manage [AWS DataSync LocationFSxONTAPs](https://docs.aws.amazon.com/datasync/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-datasync-locationfsxontap.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const locationfsxontap = await AWS.DataSync.LocationFSxONTAP("locationfsxontap-example", {
  StorageVirtualMachineArn: "example-storagevirtualmachinearn",
  SecurityGroupArns: ["example-securitygrouparns-1"],
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a locationfsxontap with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedLocationFSxONTAP = await AWS.DataSync.LocationFSxONTAP("advanced-locationfsxontap", {
  StorageVirtualMachineArn: "example-storagevirtualmachinearn",
  SecurityGroupArns: ["example-securitygrouparns-1"],
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

