---
title: Managing AWS CUR ReportDefinitions with Alchemy
description: Learn how to create, update, and manage AWS CUR ReportDefinitions using Alchemy Cloud Control.
---

# ReportDefinition

The ReportDefinition resource lets you create and manage [AWS CUR ReportDefinitions](https://docs.aws.amazon.com/cur/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-cur-reportdefinition.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const reportdefinition = await AWS.CUR.ReportDefinition("reportdefinition-example", {
  ReportName: "reportdefinition-report",
  Compression: "example-compression",
  Format: "example-format",
  RefreshClosedReports: true,
  S3Bucket: "example-s3bucket",
  ReportVersioning: "example-reportversioning",
  S3Region: "example-s3region",
  TimeUnit: "example-timeunit",
  S3Prefix: "example-s3prefix",
});
```

