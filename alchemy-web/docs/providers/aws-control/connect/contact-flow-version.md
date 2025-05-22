---
title: Managing AWS Connect ContactFlowVersions with Alchemy
description: Learn how to create, update, and manage AWS Connect ContactFlowVersions using Alchemy Cloud Control.
---

# ContactFlowVersion

The ContactFlowVersion resource lets you create and manage [AWS Connect ContactFlowVersions](https://docs.aws.amazon.com/connect/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-connect-contactflowversion.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const contactflowversion = await AWS.Connect.ContactFlowVersion("contactflowversion-example", {
  ContactFlowId: "example-contactflowid",
  Description: "A contactflowversion resource managed by Alchemy",
});
```

## Advanced Configuration

Create a contactflowversion with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedContactFlowVersion = await AWS.Connect.ContactFlowVersion(
  "advanced-contactflowversion",
  {
    ContactFlowId: "example-contactflowid",
    Description: "A contactflowversion resource managed by Alchemy",
  }
);
```

