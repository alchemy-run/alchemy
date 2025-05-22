---
title: Managing AWS Logs QueryDefinitions with Alchemy
description: Learn how to create, update, and manage AWS Logs QueryDefinitions using Alchemy Cloud Control.
---

# QueryDefinition

The QueryDefinition resource lets you create and manage [AWS Logs QueryDefinitions](https://docs.aws.amazon.com/logs/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-logs-querydefinition.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const querydefinition = await AWS.Logs.QueryDefinition("querydefinition-example", {
  QueryString: "example-querystring",
  Name: "querydefinition-",
});
```

