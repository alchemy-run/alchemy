---
title: Managing AWS FIS TargetAccountConfigurations with Alchemy
description: Learn how to create, update, and manage AWS FIS TargetAccountConfigurations using Alchemy Cloud Control.
---

# TargetAccountConfiguration

The TargetAccountConfiguration resource lets you create and manage [AWS FIS TargetAccountConfigurations](https://docs.aws.amazon.com/fis/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-fis-targetaccountconfiguration.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const targetaccountconfiguration = await AWS.FIS.TargetAccountConfiguration(
  "targetaccountconfiguration-example",
  {
    AccountId: "example-accountid",
    ExperimentTemplateId: "example-experimenttemplateid",
    RoleArn: "example-rolearn",
    Description: "A targetaccountconfiguration resource managed by Alchemy",
  }
);
```

## Advanced Configuration

Create a targetaccountconfiguration with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedTargetAccountConfiguration = await AWS.FIS.TargetAccountConfiguration(
  "advanced-targetaccountconfiguration",
  {
    AccountId: "example-accountid",
    ExperimentTemplateId: "example-experimenttemplateid",
    RoleArn: "example-rolearn",
    Description: "A targetaccountconfiguration resource managed by Alchemy",
  }
);
```

