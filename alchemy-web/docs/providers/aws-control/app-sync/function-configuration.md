---
title: Managing AWS AppSync FunctionConfigurations with Alchemy
description: Learn how to create, update, and manage AWS AppSync FunctionConfigurations using Alchemy Cloud Control.
---

# FunctionConfiguration

The FunctionConfiguration resource lets you create and manage [AWS AppSync FunctionConfigurations](https://docs.aws.amazon.com/appsync/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-appsync-functionconfiguration.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const functionconfiguration = await AWS.AppSync.FunctionConfiguration(
  "functionconfiguration-example",
  {
    Name: "functionconfiguration-",
    DataSourceName: "functionconfiguration-datasource",
    ApiId: "example-apiid",
    Description: "A functionconfiguration resource managed by Alchemy",
  }
);
```

## Advanced Configuration

Create a functionconfiguration with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedFunctionConfiguration = await AWS.AppSync.FunctionConfiguration(
  "advanced-functionconfiguration",
  {
    Name: "functionconfiguration-",
    DataSourceName: "functionconfiguration-datasource",
    ApiId: "example-apiid",
    Description: "A functionconfiguration resource managed by Alchemy",
  }
);
```

