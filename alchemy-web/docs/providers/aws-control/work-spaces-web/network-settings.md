---
title: Managing AWS WorkSpacesWeb NetworkSettingss with Alchemy
description: Learn how to create, update, and manage AWS WorkSpacesWeb NetworkSettingss using Alchemy Cloud Control.
---

# NetworkSettings

The NetworkSettings resource lets you create and manage [AWS WorkSpacesWeb NetworkSettingss](https://docs.aws.amazon.com/workspacesweb/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-workspacesweb-networksettings.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const networksettings = await AWS.WorkSpacesWeb.NetworkSettings("networksettings-example", {
  VpcId: "example-vpcid",
  SecurityGroupIds: ["example-securitygroupids-1"],
  SubnetIds: ["example-subnetids-1"],
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a networksettings with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedNetworkSettings = await AWS.WorkSpacesWeb.NetworkSettings(
  "advanced-networksettings",
  {
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
  }
);
```

