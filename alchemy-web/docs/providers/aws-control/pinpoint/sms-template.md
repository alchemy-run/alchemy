---
title: Managing AWS Pinpoint SmsTemplates with Alchemy
description: Learn how to create, update, and manage AWS Pinpoint SmsTemplates using Alchemy Cloud Control.
---

# SmsTemplate

The SmsTemplate resource lets you create and manage [AWS Pinpoint SmsTemplates](https://docs.aws.amazon.com/pinpoint/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-pinpoint-smstemplate.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const smstemplate = await AWS.Pinpoint.SmsTemplate("smstemplate-example", {
  TemplateName: "smstemplate-template",
  Body: "example-body",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a smstemplate with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedSmsTemplate = await AWS.Pinpoint.SmsTemplate("advanced-smstemplate", {
  TemplateName: "smstemplate-template",
  Body: "example-body",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

