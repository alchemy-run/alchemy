---
title: Managing AWS Redshift Integrations with Alchemy
description: Learn how to create, update, and manage AWS Redshift Integrations using Alchemy Cloud Control.
---

# Integration

The Integration resource lets you create and manage [AWS Redshift Integrations](https://docs.aws.amazon.com/redshift/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-redshift-integration.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const integration = await AWS.Redshift.Integration("integration-example", {
  SourceArn: "example-sourcearn",
  TargetArn: "example-targetarn",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a integration with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedIntegration = await AWS.Redshift.Integration("advanced-integration", {
  SourceArn: "example-sourcearn",
  TargetArn: "example-targetarn",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

