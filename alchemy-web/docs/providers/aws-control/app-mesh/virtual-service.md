---
title: Managing AWS AppMesh VirtualServices with Alchemy
description: Learn how to create, update, and manage AWS AppMesh VirtualServices using Alchemy Cloud Control.
---

# VirtualService

The VirtualService resource lets you create and manage [AWS AppMesh VirtualServices](https://docs.aws.amazon.com/appmesh/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-appmesh-virtualservice.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const virtualservice = await AWS.AppMesh.VirtualService("virtualservice-example", {
  MeshName: "virtualservice-mesh",
  VirtualServiceName: "virtualservice-virtualservice",
  Spec: "example-spec",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a virtualservice with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedVirtualService = await AWS.AppMesh.VirtualService("advanced-virtualservice", {
  MeshName: "virtualservice-mesh",
  VirtualServiceName: "virtualservice-virtualservice",
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

