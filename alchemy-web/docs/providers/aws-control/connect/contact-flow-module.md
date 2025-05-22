---
title: Managing AWS Connect ContactFlowModules with Alchemy
description: Learn how to create, update, and manage AWS Connect ContactFlowModules using Alchemy Cloud Control.
---

# ContactFlowModule

The ContactFlowModule resource lets you create and manage [AWS Connect ContactFlowModules](https://docs.aws.amazon.com/connect/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-connect-contactflowmodule.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const contactflowmodule = await AWS.Connect.ContactFlowModule("contactflowmodule-example", {
  Content: "example-content",
  InstanceArn: "example-instancearn",
  Name: "contactflowmodule-",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A contactflowmodule resource managed by Alchemy",
});
```

## Advanced Configuration

Create a contactflowmodule with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedContactFlowModule = await AWS.Connect.ContactFlowModule(
  "advanced-contactflowmodule",
  {
    Content: "example-content",
    InstanceArn: "example-instancearn",
    Name: "contactflowmodule-",
    Tags: {
      Environment: "production",
      Team: "DevOps",
      Project: "MyApp",
      CostCenter: "Engineering",
      ManagedBy: "Alchemy",
    },
    Description: "A contactflowmodule resource managed by Alchemy",
  }
);
```

