---
title: Managing AWS KafkaConnect WorkerConfigurations with Alchemy
description: Learn how to create, update, and manage AWS KafkaConnect WorkerConfigurations using Alchemy Cloud Control.
---

# WorkerConfiguration

The WorkerConfiguration resource lets you create and manage [AWS KafkaConnect WorkerConfigurations](https://docs.aws.amazon.com/kafkaconnect/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-kafkaconnect-workerconfiguration.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const workerconfiguration = await AWS.KafkaConnect.WorkerConfiguration(
  "workerconfiguration-example",
  {
    PropertiesFileContent: "example-propertiesfilecontent",
    Name: "workerconfiguration-",
    Tags: { Environment: "production", ManagedBy: "Alchemy" },
    Description: "A workerconfiguration resource managed by Alchemy",
  }
);
```

## Advanced Configuration

Create a workerconfiguration with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedWorkerConfiguration = await AWS.KafkaConnect.WorkerConfiguration(
  "advanced-workerconfiguration",
  {
    PropertiesFileContent: "example-propertiesfilecontent",
    Name: "workerconfiguration-",
    Tags: {
      Environment: "production",
      Team: "DevOps",
      Project: "MyApp",
      CostCenter: "Engineering",
      ManagedBy: "Alchemy",
    },
    Description: "A workerconfiguration resource managed by Alchemy",
  }
);
```

