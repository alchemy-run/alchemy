---
title: Managing AWS OpsWorks Apps with Alchemy
description: Learn how to create, update, and manage AWS OpsWorks Apps using Alchemy Cloud Control.
---

# App

The App resource lets you create and manage [AWS OpsWorks Apps](https://docs.aws.amazon.com/opsworks/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-opsworks-app.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const app = await AWS.OpsWorks.App("app-example", {
  Name: "app-",
  StackId: "example-stackid",
  Type: "example-type",
  Description: "A app resource managed by Alchemy",
});
```

## Advanced Configuration

Create a app with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedApp = await AWS.OpsWorks.App("advanced-app", {
  Name: "app-",
  StackId: "example-stackid",
  Type: "example-type",
  Description: "A app resource managed by Alchemy",
});
```

