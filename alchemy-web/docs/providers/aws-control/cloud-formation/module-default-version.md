---
title: Managing AWS CloudFormation ModuleDefaultVersions with Alchemy
description: Learn how to create, update, and manage AWS CloudFormation ModuleDefaultVersions using Alchemy Cloud Control.
---

# ModuleDefaultVersion

The ModuleDefaultVersion resource lets you create and manage [AWS CloudFormation ModuleDefaultVersions](https://docs.aws.amazon.com/cloudformation/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-cloudformation-moduledefaultversion.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const moduledefaultversion = await AWS.CloudFormation.ModuleDefaultVersion(
  "moduledefaultversion-example",
  {}
);
```

