---
title: Managing AWS Bedrock FlowVersions with Alchemy
description: Learn how to create, update, and manage AWS Bedrock FlowVersions using Alchemy Cloud Control.
---

# FlowVersion

The FlowVersion resource lets you create and manage [AWS Bedrock FlowVersions](https://docs.aws.amazon.com/bedrock/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-bedrock-flowversion.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const flowversion = await AWS.Bedrock.FlowVersion("flowversion-example", {
  FlowArn: "example-flowarn",
  Description: "A flowversion resource managed by Alchemy",
});
```

## Advanced Configuration

Create a flowversion with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedFlowVersion = await AWS.Bedrock.FlowVersion("advanced-flowversion", {
  FlowArn: "example-flowarn",
  Description: "A flowversion resource managed by Alchemy",
});
```

