---
title: Managing AWS IoTSiteWise Projects with Alchemy
description: Learn how to create, update, and manage AWS IoTSiteWise Projects using Alchemy Cloud Control.
---

# Project

The Project resource lets you create and manage [AWS IoTSiteWise Projects](https://docs.aws.amazon.com/iotsitewise/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-iotsitewise-project.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const project = await AWS.IoTSiteWise.Project("project-example", {
  ProjectName: "project-project",
  PortalId: "example-portalid",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a project with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedProject = await AWS.IoTSiteWise.Project("advanced-project", {
  ProjectName: "project-project",
  PortalId: "example-portalid",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

