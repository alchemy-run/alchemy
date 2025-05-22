---
title: Managing AWS AppMesh VirtualRouters with Alchemy
description: Learn how to create, update, and manage AWS AppMesh VirtualRouters using Alchemy Cloud Control.
---

# VirtualRouter

The VirtualRouter resource lets you create and manage [AWS AppMesh VirtualRouters](https://docs.aws.amazon.com/appmesh/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-appmesh-virtualrouter.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const virtualrouter = await AWS.AppMesh.VirtualRouter("virtualrouter-example", {
  MeshName: "virtualrouter-mesh",
  Spec: "example-spec",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a virtualrouter with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedVirtualRouter = await AWS.AppMesh.VirtualRouter("advanced-virtualrouter", {
  MeshName: "virtualrouter-mesh",
  Spec: "example-spec",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

