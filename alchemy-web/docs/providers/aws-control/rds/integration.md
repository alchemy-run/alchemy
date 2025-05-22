---
title: Managing AWS RDS Integrations with Alchemy
description: Learn how to create, update, and manage AWS RDS Integrations using Alchemy Cloud Control.
---

# Integration

The Integration resource lets you create and manage [AWS RDS Integrations](https://docs.aws.amazon.com/rds/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-rds-integration.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const integration = await AWS.RDS.Integration("integration-example", {
  SourceArn: "example-sourcearn",
  TargetArn: "example-targetarn",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A integration resource managed by Alchemy",
});
```

## Advanced Configuration

Create a integration with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedIntegration = await AWS.RDS.Integration("advanced-integration", {
  SourceArn: "example-sourcearn",
  TargetArn: "example-targetarn",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A integration resource managed by Alchemy",
});
```

