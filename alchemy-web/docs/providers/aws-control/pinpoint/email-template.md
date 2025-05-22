---
title: Managing AWS Pinpoint EmailTemplates with Alchemy
description: Learn how to create, update, and manage AWS Pinpoint EmailTemplates using Alchemy Cloud Control.
---

# EmailTemplate

The EmailTemplate resource lets you create and manage [AWS Pinpoint EmailTemplates](https://docs.aws.amazon.com/pinpoint/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-pinpoint-emailtemplate.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const emailtemplate = await AWS.Pinpoint.EmailTemplate("emailtemplate-example", {
  TemplateName: "emailtemplate-template",
  Subject: "example-subject",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a emailtemplate with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedEmailTemplate = await AWS.Pinpoint.EmailTemplate("advanced-emailtemplate", {
  TemplateName: "emailtemplate-template",
  Subject: "example-subject",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

