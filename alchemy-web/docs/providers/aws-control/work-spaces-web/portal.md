---
title: Managing AWS WorkSpacesWeb Portals with Alchemy
description: Learn how to create, update, and manage AWS WorkSpacesWeb Portals using Alchemy Cloud Control.
---

# Portal

The Portal resource lets you create and manage [AWS WorkSpacesWeb Portals](https://docs.aws.amazon.com/workspacesweb/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-workspacesweb-portal.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const portal = await AWS.WorkSpacesWeb.Portal("portal-example", {
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a portal with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedPortal = await AWS.WorkSpacesWeb.Portal("advanced-portal", {
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

