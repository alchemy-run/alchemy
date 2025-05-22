---
title: Managing AWS IoTTwinMaker ComponentTypes with Alchemy
description: Learn how to create, update, and manage AWS IoTTwinMaker ComponentTypes using Alchemy Cloud Control.
---

# ComponentType

The ComponentType resource lets you create and manage [AWS IoTTwinMaker ComponentTypes](https://docs.aws.amazon.com/iottwinmaker/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-iottwinmaker-componenttype.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const componenttype = await AWS.IoTTwinMaker.ComponentType("componenttype-example", {
  WorkspaceId: "example-workspaceid",
  ComponentTypeId: "example-componenttypeid",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A componenttype resource managed by Alchemy",
});
```

## Advanced Configuration

Create a componenttype with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedComponentType = await AWS.IoTTwinMaker.ComponentType("advanced-componenttype", {
  WorkspaceId: "example-workspaceid",
  ComponentTypeId: "example-componenttypeid",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A componenttype resource managed by Alchemy",
});
```

