---
title: Managing AWS Connect ContactFlows with Alchemy
description: Learn how to create, update, and manage AWS Connect ContactFlows using Alchemy Cloud Control.
---

# ContactFlow

The ContactFlow resource lets you create and manage [AWS Connect ContactFlows](https://docs.aws.amazon.com/connect/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-connect-contactflow.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const contactflow = await AWS.Connect.ContactFlow("contactflow-example", {
  Type: "example-type",
  Content: "example-content",
  InstanceArn: "example-instancearn",
  Name: "contactflow-",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A contactflow resource managed by Alchemy",
});
```

## Advanced Configuration

Create a contactflow with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedContactFlow = await AWS.Connect.ContactFlow("advanced-contactflow", {
  Type: "example-type",
  Content: "example-content",
  InstanceArn: "example-instancearn",
  Name: "contactflow-",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A contactflow resource managed by Alchemy",
});
```

