---
title: Managing AWS CodeBuild ReportGroups with Alchemy
description: Learn how to create, update, and manage AWS CodeBuild ReportGroups using Alchemy Cloud Control.
---

# ReportGroup

The ReportGroup resource lets you create and manage [AWS CodeBuild ReportGroups](https://docs.aws.amazon.com/codebuild/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-codebuild-reportgroup.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const reportgroup = await AWS.CodeBuild.ReportGroup("reportgroup-example", {
  Type: "example-type",
  ExportConfig: "example-exportconfig",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a reportgroup with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedReportGroup = await AWS.CodeBuild.ReportGroup("advanced-reportgroup", {
  Type: "example-type",
  ExportConfig: "example-exportconfig",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

