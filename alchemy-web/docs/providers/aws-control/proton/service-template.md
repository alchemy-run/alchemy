---
title: Managing AWS Proton ServiceTemplates with Alchemy
description: Learn how to create, update, and manage AWS Proton ServiceTemplates using Alchemy Cloud Control.
---

# ServiceTemplate

The ServiceTemplate resource lets you create and manage [AWS Proton ServiceTemplates](https://docs.aws.amazon.com/proton/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-proton-servicetemplate.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const servicetemplate = await AWS.Proton.ServiceTemplate("servicetemplate-example", {
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A servicetemplate resource managed by Alchemy",
});
```

## Advanced Configuration

Create a servicetemplate with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedServiceTemplate = await AWS.Proton.ServiceTemplate("advanced-servicetemplate", {
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A servicetemplate resource managed by Alchemy",
});
```

