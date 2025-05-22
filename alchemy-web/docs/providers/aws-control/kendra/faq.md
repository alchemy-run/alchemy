---
title: Managing AWS Kendra Faqs with Alchemy
description: Learn how to create, update, and manage AWS Kendra Faqs using Alchemy Cloud Control.
---

# Faq

The Faq resource lets you create and manage [AWS Kendra Faqs](https://docs.aws.amazon.com/kendra/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-kendra-faq.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const faq = await AWS.Kendra.Faq("faq-example", {
  IndexId: "example-indexid",
  S3Path: "example-s3path",
  RoleArn: "example-rolearn",
  Name: "faq-",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A faq resource managed by Alchemy",
});
```

## Advanced Configuration

Create a faq with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedFaq = await AWS.Kendra.Faq("advanced-faq", {
  IndexId: "example-indexid",
  S3Path: "example-s3path",
  RoleArn: "example-rolearn",
  Name: "faq-",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A faq resource managed by Alchemy",
});
```

