---
title: Managing AWS EMRContainers VirtualClusters with Alchemy
description: Learn how to create, update, and manage AWS EMRContainers VirtualClusters using Alchemy Cloud Control.
---

# VirtualCluster

The VirtualCluster resource lets you create and manage [AWS EMRContainers VirtualClusters](https://docs.aws.amazon.com/emrcontainers/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-emrcontainers-virtualcluster.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const virtualcluster = await AWS.EMRContainers.VirtualCluster("virtualcluster-example", {
  ContainerProvider: "example-containerprovider",
  Name: "virtualcluster-",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a virtualcluster with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedVirtualCluster = await AWS.EMRContainers.VirtualCluster("advanced-virtualcluster", {
  ContainerProvider: "example-containerprovider",
  Name: "virtualcluster-",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

