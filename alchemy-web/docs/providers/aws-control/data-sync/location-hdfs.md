---
title: Managing AWS DataSync LocationHDFSs with Alchemy
description: Learn how to create, update, and manage AWS DataSync LocationHDFSs using Alchemy Cloud Control.
---

# LocationHDFS

The LocationHDFS resource lets you create and manage [AWS DataSync LocationHDFSs](https://docs.aws.amazon.com/datasync/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-datasync-locationhdfs.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const locationhdfs = await AWS.DataSync.LocationHDFS("locationhdfs-example", {
  NameNodes: "locationhdfs-nodes",
  AgentArns: ["example-agentarns-1"],
  AuthenticationType: "example-authenticationtype",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a locationhdfs with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedLocationHDFS = await AWS.DataSync.LocationHDFS("advanced-locationhdfs", {
  NameNodes: "locationhdfs-nodes",
  AgentArns: ["example-agentarns-1"],
  AuthenticationType: "example-authenticationtype",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

