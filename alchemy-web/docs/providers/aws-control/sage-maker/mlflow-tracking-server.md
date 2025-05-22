---
title: Managing AWS SageMaker MlflowTrackingServers with Alchemy
description: Learn how to create, update, and manage AWS SageMaker MlflowTrackingServers using Alchemy Cloud Control.
---

# MlflowTrackingServer

The MlflowTrackingServer resource lets you create and manage [AWS SageMaker MlflowTrackingServers](https://docs.aws.amazon.com/sagemaker/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-sagemaker-mlflowtrackingserver.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const mlflowtrackingserver = await AWS.SageMaker.MlflowTrackingServer(
  "mlflowtrackingserver-example",
  {
    TrackingServerName: "mlflowtrackingserver-trackingserver",
    ArtifactStoreUri: "example-artifactstoreuri",
    RoleArn: "example-rolearn",
    Tags: { Environment: "production", ManagedBy: "Alchemy" },
  }
);
```

## Advanced Configuration

Create a mlflowtrackingserver with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedMlflowTrackingServer = await AWS.SageMaker.MlflowTrackingServer(
  "advanced-mlflowtrackingserver",
  {
    TrackingServerName: "mlflowtrackingserver-trackingserver",
    ArtifactStoreUri: "example-artifactstoreuri",
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

