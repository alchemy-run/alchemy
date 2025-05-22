---
title: Managing AWS FraudDetector Outcomes with Alchemy
description: Learn how to create, update, and manage AWS FraudDetector Outcomes using Alchemy Cloud Control.
---

# Outcome

The Outcome resource lets you create and manage [AWS FraudDetector Outcomes](https://docs.aws.amazon.com/frauddetector/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-frauddetector-outcome.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const outcome = await AWS.FraudDetector.Outcome("outcome-example", {
  Name: "outcome-",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A outcome resource managed by Alchemy",
});
```

## Advanced Configuration

Create a outcome with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedOutcome = await AWS.FraudDetector.Outcome("advanced-outcome", {
  Name: "outcome-",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A outcome resource managed by Alchemy",
});
```

