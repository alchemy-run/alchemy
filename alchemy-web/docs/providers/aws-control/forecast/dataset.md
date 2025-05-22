---
title: Managing AWS Forecast Datasets with Alchemy
description: Learn how to create, update, and manage AWS Forecast Datasets using Alchemy Cloud Control.
---

# Dataset

The Dataset resource lets you create and manage [AWS Forecast Datasets](https://docs.aws.amazon.com/forecast/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-forecast-dataset.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const dataset = await AWS.Forecast.Dataset("dataset-example", {
  DatasetName: "dataset-dataset",
  Schema: "example-schema",
  DatasetType: "example-datasettype",
  Domain: "example-domain",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a dataset with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedDataset = await AWS.Forecast.Dataset("advanced-dataset", {
  DatasetName: "dataset-dataset",
  Schema: "example-schema",
  DatasetType: "example-datasettype",
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

