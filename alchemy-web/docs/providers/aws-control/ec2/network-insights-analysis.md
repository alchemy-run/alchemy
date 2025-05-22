---
title: Managing AWS EC2 NetworkInsightsAnalysiss with Alchemy
description: Learn how to create, update, and manage AWS EC2 NetworkInsightsAnalysiss using Alchemy Cloud Control.
---

# NetworkInsightsAnalysis

The NetworkInsightsAnalysis resource lets you create and manage [AWS EC2 NetworkInsightsAnalysiss](https://docs.aws.amazon.com/ec2/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ec2-networkinsightsanalysis.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const networkinsightsanalysis = await AWS.EC2.NetworkInsightsAnalysis(
  "networkinsightsanalysis-example",
  {
    NetworkInsightsPathId: "example-networkinsightspathid",
    Tags: { Environment: "production", ManagedBy: "Alchemy" },
  }
);
```

## Advanced Configuration

Create a networkinsightsanalysis with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedNetworkInsightsAnalysis = await AWS.EC2.NetworkInsightsAnalysis(
  "advanced-networkinsightsanalysis",
  {
    NetworkInsightsPathId: "example-networkinsightspathid",
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

