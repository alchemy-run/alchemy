---
title: Managing AWS AppConfig ExtensionAssociations with Alchemy
description: Learn how to create, update, and manage AWS AppConfig ExtensionAssociations using Alchemy Cloud Control.
---

# ExtensionAssociation

The ExtensionAssociation resource lets you create and manage [AWS AppConfig ExtensionAssociations](https://docs.aws.amazon.com/appconfig/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-appconfig-extensionassociation.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const extensionassociation = await AWS.AppConfig.ExtensionAssociation(
  "extensionassociation-example",
  { Tags: { Environment: "production", ManagedBy: "Alchemy" } }
);
```

## Advanced Configuration

Create a extensionassociation with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedExtensionAssociation = await AWS.AppConfig.ExtensionAssociation(
  "advanced-extensionassociation",
  {
    Tags: {
      Environment: "production",
      Team: "DevOps",
      Project: "MyApp",
      CostCenter: "Engineering",
      ManagedBy: "Alchemy",
    },
  }
);
```

