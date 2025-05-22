---
title: Managing AWS AppMesh Meshs with Alchemy
description: Learn how to create, update, and manage AWS AppMesh Meshs using Alchemy Cloud Control.
---

# Mesh

The Mesh resource lets you create and manage [AWS AppMesh Meshs](https://docs.aws.amazon.com/appmesh/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-appmesh-mesh.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const mesh = await AWS.AppMesh.Mesh("mesh-example", {
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a mesh with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedMesh = await AWS.AppMesh.Mesh("advanced-mesh", {
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

