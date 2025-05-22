---
title: Managing AWS EC2 NetworkInsightsAccessScopeAnalysiss with Alchemy
description: Learn how to create, update, and manage AWS EC2 NetworkInsightsAccessScopeAnalysiss using Alchemy Cloud Control.
---

# NetworkInsightsAccessScopeAnalysis

The NetworkInsightsAccessScopeAnalysis resource lets you create and manage [AWS EC2 NetworkInsightsAccessScopeAnalysiss](https://docs.aws.amazon.com/ec2/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ec2-networkinsightsaccessscopeanalysis.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const networkinsightsaccessscopeanalysis = await AWS.EC2.NetworkInsightsAccessScopeAnalysis(
  "networkinsightsaccessscopeanalysis-example",
  {
    NetworkInsightsAccessScopeId: "example-networkinsightsaccessscopeid",
    Tags: { Environment: "production", ManagedBy: "Alchemy" },
  }
);
```

## Advanced Configuration

Create a networkinsightsaccessscopeanalysis with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedNetworkInsightsAccessScopeAnalysis = await AWS.EC2.NetworkInsightsAccessScopeAnalysis(
  "advanced-networkinsightsaccessscopeanalysis",
  {
    NetworkInsightsAccessScopeId: "example-networkinsightsaccessscopeid",
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

