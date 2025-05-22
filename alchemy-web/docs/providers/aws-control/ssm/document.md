---
title: Managing AWS SSM Documents with Alchemy
description: Learn how to create, update, and manage AWS SSM Documents using Alchemy Cloud Control.
---

# Document

The Document resource lets you create and manage [AWS SSM Documents](https://docs.aws.amazon.com/ssm/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ssm-document.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const document = await AWS.SSM.Document("document-example", {
  Content: {},
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a document with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedDocument = await AWS.SSM.Document("advanced-document", {
  Content: {},
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

