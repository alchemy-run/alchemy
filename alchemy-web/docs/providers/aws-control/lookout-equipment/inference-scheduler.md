---
title: Managing AWS LookoutEquipment InferenceSchedulers with Alchemy
description: Learn how to create, update, and manage AWS LookoutEquipment InferenceSchedulers using Alchemy Cloud Control.
---

# InferenceScheduler

The InferenceScheduler resource lets you create and manage [AWS LookoutEquipment InferenceSchedulers](https://docs.aws.amazon.com/lookoutequipment/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-lookoutequipment-inferencescheduler.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const inferencescheduler = await AWS.LookoutEquipment.InferenceScheduler(
  "inferencescheduler-example",
  {
    DataUploadFrequency: "example-datauploadfrequency",
    ModelName: "inferencescheduler-model",
    DataInputConfiguration: "example-datainputconfiguration",
    DataOutputConfiguration: "example-dataoutputconfiguration",
    RoleArn: "example-rolearn",
    Tags: { Environment: "production", ManagedBy: "Alchemy" },
  }
);
```

## Advanced Configuration

Create a inferencescheduler with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedInferenceScheduler = await AWS.LookoutEquipment.InferenceScheduler(
  "advanced-inferencescheduler",
  {
    DataUploadFrequency: "example-datauploadfrequency",
    ModelName: "inferencescheduler-model",
    DataInputConfiguration: "example-datainputconfiguration",
    DataOutputConfiguration: "example-dataoutputconfiguration",
    RoleArn: "example-rolearn",
    Tags: {
      Environment: "production",
      Team: "DevOps",
      Project: "MyApp",
      CostCenter: "Engineering",
      ManagedBy: "Alchemy",
    },
  }
);
```

