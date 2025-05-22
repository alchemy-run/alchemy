---
title: Managing AWS Synthetics Canarys with Alchemy
description: Learn how to create, update, and manage AWS Synthetics Canarys using Alchemy Cloud Control.
---

# Canary

The Canary resource lets you create and manage [AWS Synthetics Canarys](https://docs.aws.amazon.com/synthetics/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-synthetics-canary.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const canary = await AWS.Synthetics.Canary("canary-example", {
  RuntimeVersion: "example-runtimeversion",
  Code: "example-code",
  Name: "canary-",
  ExecutionRoleArn: "example-executionrolearn",
  Schedule: "example-schedule",
  ArtifactS3Location: "example-artifacts3location",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a canary with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedCanary = await AWS.Synthetics.Canary("advanced-canary", {
  RuntimeVersion: "example-runtimeversion",
  Code: "example-code",
  Name: "canary-",
  ExecutionRoleArn: "example-executionrolearn",
  Schedule: "example-schedule",
  ArtifactS3Location: "example-artifacts3location",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

