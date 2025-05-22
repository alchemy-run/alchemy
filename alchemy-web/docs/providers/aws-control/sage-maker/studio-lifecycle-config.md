---
title: Managing AWS SageMaker StudioLifecycleConfigs with Alchemy
description: Learn how to create, update, and manage AWS SageMaker StudioLifecycleConfigs using Alchemy Cloud Control.
---

# StudioLifecycleConfig

The StudioLifecycleConfig resource lets you create and manage [AWS SageMaker StudioLifecycleConfigs](https://docs.aws.amazon.com/sagemaker/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-sagemaker-studiolifecycleconfig.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const studiolifecycleconfig = await AWS.SageMaker.StudioLifecycleConfig(
  "studiolifecycleconfig-example",
  {
    StudioLifecycleConfigAppType: "example-studiolifecycleconfigapptype",
    StudioLifecycleConfigName: "studiolifecycleconfig-studiolifecycleconfig",
    StudioLifecycleConfigContent: "example-studiolifecycleconfigcontent",
    Tags: { Environment: "production", ManagedBy: "Alchemy" },
  }
);
```

## Advanced Configuration

Create a studiolifecycleconfig with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedStudioLifecycleConfig = await AWS.SageMaker.StudioLifecycleConfig(
  "advanced-studiolifecycleconfig",
  {
    StudioLifecycleConfigAppType: "example-studiolifecycleconfigapptype",
    StudioLifecycleConfigName: "studiolifecycleconfig-studiolifecycleconfig",
    StudioLifecycleConfigContent: "example-studiolifecycleconfigcontent",
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

