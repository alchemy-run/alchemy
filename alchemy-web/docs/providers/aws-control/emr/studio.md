---
title: Managing AWS EMR Studios with Alchemy
description: Learn how to create, update, and manage AWS EMR Studios using Alchemy Cloud Control.
---

# Studio

The Studio resource lets you create and manage [AWS EMR Studios](https://docs.aws.amazon.com/emr/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-emr-studio.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const studio = await AWS.EMR.Studio("studio-example", {
  WorkspaceSecurityGroupId: "example-workspacesecuritygroupid",
  DefaultS3Location: "example-defaults3location",
  SubnetIds: ["example-subnetids-1"],
  Name: "studio-",
  ServiceRole: "example-servicerole",
  VpcId: "example-vpcid",
  EngineSecurityGroupId: "example-enginesecuritygroupid",
  AuthMode: "example-authmode",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A studio resource managed by Alchemy",
});
```

## Advanced Configuration

Create a studio with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedStudio = await AWS.EMR.Studio("advanced-studio", {
  WorkspaceSecurityGroupId: "example-workspacesecuritygroupid",
  DefaultS3Location: "example-defaults3location",
  SubnetIds: ["example-subnetids-1"],
  Name: "studio-",
  ServiceRole: "example-servicerole",
  VpcId: "example-vpcid",
  EngineSecurityGroupId: "example-enginesecuritygroupid",
  AuthMode: "example-authmode",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A studio resource managed by Alchemy",
});
```

