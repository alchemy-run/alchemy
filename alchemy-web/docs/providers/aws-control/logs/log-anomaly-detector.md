---
title: Managing AWS Logs LogAnomalyDetectors with Alchemy
description: Learn how to create, update, and manage AWS Logs LogAnomalyDetectors using Alchemy Cloud Control.
---

# LogAnomalyDetector

The LogAnomalyDetector resource lets you create and manage [AWS Logs LogAnomalyDetectors](https://docs.aws.amazon.com/logs/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-logs-loganomalydetector.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const loganomalydetector = await AWS.Logs.LogAnomalyDetector("loganomalydetector-example", {});
```

