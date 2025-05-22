---
title: Managing AWS StepFunctions StateMachineVersions with Alchemy
description: Learn how to create, update, and manage AWS StepFunctions StateMachineVersions using Alchemy Cloud Control.
---

# StateMachineVersion

The StateMachineVersion resource lets you create and manage [AWS StepFunctions StateMachineVersions](https://docs.aws.amazon.com/stepfunctions/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-stepfunctions-statemachineversion.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const statemachineversion = await AWS.StepFunctions.StateMachineVersion(
  "statemachineversion-example",
  {
    StateMachineArn: "example-statemachinearn",
    Description: "A statemachineversion resource managed by Alchemy",
  }
);
```

## Advanced Configuration

Create a statemachineversion with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedStateMachineVersion = await AWS.StepFunctions.StateMachineVersion(
  "advanced-statemachineversion",
  {
    StateMachineArn: "example-statemachinearn",
    Description: "A statemachineversion resource managed by Alchemy",
  }
);
```

