---
title: Managing AWS CloudFormation HookDefaultVersions with Alchemy
description: Learn how to create, update, and manage AWS CloudFormation HookDefaultVersions using Alchemy Cloud Control.
---

# HookDefaultVersion

The HookDefaultVersion resource lets you create and manage [AWS CloudFormation HookDefaultVersions](https://docs.aws.amazon.com/cloudformation/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-cloudformation-hookdefaultversion.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const hookdefaultversion = await AWS.CloudFormation.HookDefaultVersion(
  "hookdefaultversion-example",
  {}
);
```

