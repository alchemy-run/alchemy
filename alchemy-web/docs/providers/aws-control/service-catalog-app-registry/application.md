---
title: Managing AWS ServiceCatalogAppRegistry Applications with Alchemy
description: Learn how to create, update, and manage AWS ServiceCatalogAppRegistry Applications using Alchemy Cloud Control.
---

# Application

The Application resource lets you create and manage [AWS ServiceCatalogAppRegistry Applications](https://docs.aws.amazon.com/servicecatalogappregistry/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-servicecatalogappregistry-application.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const application = await AWS.ServiceCatalogAppRegistry.Application("application-example", {
  Name: "application-",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A application resource managed by Alchemy",
});
```

## Advanced Configuration

Create a application with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedApplication = await AWS.ServiceCatalogAppRegistry.Application(
  "advanced-application",
  {
    Name: "application-",
    Tags: {
      Environment: "production",
      Team: "DevOps",
      Project: "MyApp",
      CostCenter: "Engineering",
      ManagedBy: "Alchemy",
    },
    Description: "A application resource managed by Alchemy",
  }
);
```

