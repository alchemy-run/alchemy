---
title: Managing AWS Glue Crawlers with Alchemy
description: Learn how to create, update, and manage AWS Glue Crawlers using Alchemy Cloud Control.
---

# Crawler

The Crawler resource lets you create and manage [AWS Glue Crawlers](https://docs.aws.amazon.com/glue/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-glue-crawler.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const crawler = await AWS.Glue.Crawler("crawler-example", {
  Targets: "example-targets",
  Role: "example-role",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A crawler resource managed by Alchemy",
});
```

## Advanced Configuration

Create a crawler with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedCrawler = await AWS.Glue.Crawler("advanced-crawler", {
  Targets: "example-targets",
  Role: "example-role",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A crawler resource managed by Alchemy",
  Configuration: "example-configuration",
});
```

