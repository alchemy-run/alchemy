---
title: Managing AWS CloudFormation WaitConditionHandles with Alchemy
description: Learn how to create, update, and manage AWS CloudFormation WaitConditionHandles using Alchemy Cloud Control.
---

# WaitConditionHandle

The WaitConditionHandle resource lets you create and manage [AWS CloudFormation WaitConditionHandles](https://docs.aws.amazon.com/cloudformation/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-waitconditionhandle.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const waitconditionhandle = await AWS.CloudFormation.WaitConditionHandle(
  "waitconditionhandle-example",
  {}
);
```

