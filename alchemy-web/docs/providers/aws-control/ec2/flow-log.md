---
title: Managing AWS EC2 FlowLogs with Alchemy
description: Learn how to create, update, and manage AWS EC2 FlowLogs using Alchemy Cloud Control.
---

# FlowLog

The FlowLog resource lets you create and manage [AWS EC2 FlowLogs](https://docs.aws.amazon.com/ec2/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ec2-flowlog.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const flowlog = await AWS.EC2.FlowLog("flowlog-example", {
  ResourceId: "example-resourceid",
  ResourceType: "example-resourcetype",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a flowlog with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedFlowLog = await AWS.EC2.FlowLog("advanced-flowlog", {
  ResourceId: "example-resourceid",
  ResourceType: "example-resourcetype",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

