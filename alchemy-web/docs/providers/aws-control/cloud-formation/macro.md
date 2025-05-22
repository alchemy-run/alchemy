---
title: Managing AWS CloudFormation Macros with Alchemy
description: Learn how to create, update, and manage AWS CloudFormation Macros using Alchemy Cloud Control.
---

# Macro

The Macro resource lets you create and manage [AWS CloudFormation Macros](https://docs.aws.amazon.com/cloudformation/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-cloudformation-macro.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const macro = await AWS.CloudFormation.Macro("macro-example", {
  FunctionName: "macro-function",
  Name: "macro-",
  Description: "A macro resource managed by Alchemy",
});
```

## Advanced Configuration

Create a macro with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedMacro = await AWS.CloudFormation.Macro("advanced-macro", {
  FunctionName: "macro-function",
  Name: "macro-",
  Description: "A macro resource managed by Alchemy",
});
```

