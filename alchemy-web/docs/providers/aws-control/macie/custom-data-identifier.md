---
title: Managing AWS Macie CustomDataIdentifiers with Alchemy
description: Learn how to create, update, and manage AWS Macie CustomDataIdentifiers using Alchemy Cloud Control.
---

# CustomDataIdentifier

The CustomDataIdentifier resource lets you create and manage [AWS Macie CustomDataIdentifiers](https://docs.aws.amazon.com/macie/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-macie-customdataidentifier.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const customdataidentifier = await AWS.Macie.CustomDataIdentifier("customdataidentifier-example", {
  Regex: "example-regex",
  Name: "customdataidentifier-",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A customdataidentifier resource managed by Alchemy",
});
```

## Advanced Configuration

Create a customdataidentifier with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedCustomDataIdentifier = await AWS.Macie.CustomDataIdentifier(
  "advanced-customdataidentifier",
  {
    Regex: "example-regex",
    Name: "customdataidentifier-",
    Tags: {
      Environment: "production",
      Team: "DevOps",
      Project: "MyApp",
      CostCenter: "Engineering",
      ManagedBy: "Alchemy",
    },
    Description: "A customdataidentifier resource managed by Alchemy",
  }
);
```

