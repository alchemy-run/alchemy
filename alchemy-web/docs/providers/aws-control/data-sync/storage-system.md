---
title: Managing AWS DataSync StorageSystems with Alchemy
description: Learn how to create, update, and manage AWS DataSync StorageSystems using Alchemy Cloud Control.
---

# StorageSystem

The StorageSystem resource lets you create and manage [AWS DataSync StorageSystems](https://docs.aws.amazon.com/datasync/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-datasync-storagesystem.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const storagesystem = await AWS.DataSync.StorageSystem("storagesystem-example", {
  ServerConfiguration: "example-serverconfiguration",
  SystemType: "example-systemtype",
  AgentArns: ["example-agentarns-1"],
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a storagesystem with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedStorageSystem = await AWS.DataSync.StorageSystem("advanced-storagesystem", {
  ServerConfiguration: "example-serverconfiguration",
  SystemType: "example-systemtype",
  AgentArns: ["example-agentarns-1"],
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

