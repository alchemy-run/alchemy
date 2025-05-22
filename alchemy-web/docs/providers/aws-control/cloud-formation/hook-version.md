---
title: Managing AWS CloudFormation HookVersions with Alchemy
description: Learn how to create, update, and manage AWS CloudFormation HookVersions using Alchemy Cloud Control.
---

# HookVersion

The HookVersion resource lets you create and manage [AWS CloudFormation HookVersions](https://docs.aws.amazon.com/cloudformation/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-cloudformation-hookversion.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const hookversion = await AWS.CloudFormation.HookVersion("hookversion-example", {
  TypeName: "hookversion-type",
  SchemaHandlerPackage: "example-schemahandlerpackage",
});
```

