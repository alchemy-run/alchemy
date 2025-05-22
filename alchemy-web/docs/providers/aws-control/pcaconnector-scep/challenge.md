---
title: Managing AWS PCAConnectorSCEP Challenges with Alchemy
description: Learn how to create, update, and manage AWS PCAConnectorSCEP Challenges using Alchemy Cloud Control.
---

# Challenge

The Challenge resource lets you create and manage [AWS PCAConnectorSCEP Challenges](https://docs.aws.amazon.com/pcaconnectorscep/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-pcaconnectorscep-challenge.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const challenge = await AWS.PCAConnectorSCEP.Challenge("challenge-example", {
  ConnectorArn: "example-connectorarn",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a challenge with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedChallenge = await AWS.PCAConnectorSCEP.Challenge("advanced-challenge", {
  ConnectorArn: "example-connectorarn",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

