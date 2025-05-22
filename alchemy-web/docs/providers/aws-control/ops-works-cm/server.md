---
title: Managing AWS OpsWorksCM Servers with Alchemy
description: Learn how to create, update, and manage AWS OpsWorksCM Servers using Alchemy Cloud Control.
---

# Server

The Server resource lets you create and manage [AWS OpsWorksCM Servers](https://docs.aws.amazon.com/opsworkscm/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-opsworkscm-server.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const server = await AWS.OpsWorksCM.Server("server-example", {
  ServiceRoleArn: "example-servicerolearn",
  InstanceProfileArn: "example-instanceprofilearn",
  InstanceType: "example-instancetype",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a server with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedServer = await AWS.OpsWorksCM.Server("advanced-server", {
  ServiceRoleArn: "example-servicerolearn",
  InstanceProfileArn: "example-instanceprofilearn",
  InstanceType: "example-instancetype",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

