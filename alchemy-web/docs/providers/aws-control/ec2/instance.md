---
title: Managing AWS EC2 Instances with Alchemy
description: Learn how to create, update, and manage AWS EC2 Instances using Alchemy Cloud Control.
---

# Instance

The Instance resource lets you create and manage [AWS EC2 Instances](https://docs.aws.amazon.com/ec2/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ec2-instance.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const instance = await AWS.EC2.Instance("instance-example", {
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a instance with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedInstance = await AWS.EC2.Instance("advanced-instance", {
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Monitoring: { Enabled: true, LoggingLevel: "INFO" },
});
```

