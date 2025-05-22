---
title: Managing AWS EventSchemas RegistryPolicys with Alchemy
description: Learn how to create, update, and manage AWS EventSchemas RegistryPolicys using Alchemy Cloud Control.
---

# RegistryPolicy

The RegistryPolicy resource lets you create and manage [AWS EventSchemas RegistryPolicys](https://docs.aws.amazon.com/eventschemas/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-eventschemas-registrypolicy.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const registrypolicy = await AWS.EventSchemas.RegistryPolicy("registrypolicy-example", {
  Policy: {},
  RegistryName: "registrypolicy-registry",
});
```

