---
title: Managing AWS AppSync Resolvers with Alchemy
description: Learn how to create, update, and manage AWS AppSync Resolvers using Alchemy Cloud Control.
---

# Resolver

The Resolver resource lets you create and manage [AWS AppSync Resolvers](https://docs.aws.amazon.com/appsync/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-appsync-resolver.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const resolver = await AWS.AppSync.Resolver("resolver-example", {
  TypeName: "resolver-type",
  ApiId: "example-apiid",
  FieldName: "resolver-field",
});
```

