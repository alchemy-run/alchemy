---
title: Managing AWS Forecast DatasetGroups with Alchemy
description: Learn how to create, update, and manage AWS Forecast DatasetGroups using Alchemy Cloud Control.
---

# DatasetGroup

The DatasetGroup resource lets you create and manage [AWS Forecast DatasetGroups](https://docs.aws.amazon.com/forecast/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-forecast-datasetgroup.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const datasetgroup = await AWS.Forecast.DatasetGroup("datasetgroup-example", {
  DatasetGroupName: "datasetgroup-datasetgroup",
  Domain: "example-domain",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a datasetgroup with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedDatasetGroup = await AWS.Forecast.DatasetGroup("advanced-datasetgroup", {
  DatasetGroupName: "datasetgroup-datasetgroup",
  Domain: "example-domain",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

