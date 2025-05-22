---
title: Managing AWS IoTTwinMaker Entitys with Alchemy
description: Learn how to create, update, and manage AWS IoTTwinMaker Entitys using Alchemy Cloud Control.
---

# Entity

The Entity resource lets you create and manage [AWS IoTTwinMaker Entitys](https://docs.aws.amazon.com/iottwinmaker/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-iottwinmaker-entity.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const entity = await AWS.IoTTwinMaker.Entity("entity-example", {
  EntityName: "entity-entity",
  WorkspaceId: "example-workspaceid",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A entity resource managed by Alchemy",
});
```

## Advanced Configuration

Create a entity with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedEntity = await AWS.IoTTwinMaker.Entity("advanced-entity", {
  EntityName: "entity-entity",
  WorkspaceId: "example-workspaceid",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A entity resource managed by Alchemy",
});
```

