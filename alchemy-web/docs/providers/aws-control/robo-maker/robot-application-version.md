---
title: Managing AWS RoboMaker RobotApplicationVersions with Alchemy
description: Learn how to create, update, and manage AWS RoboMaker RobotApplicationVersions using Alchemy Cloud Control.
---

# RobotApplicationVersion

The RobotApplicationVersion resource lets you create and manage [AWS RoboMaker RobotApplicationVersions](https://docs.aws.amazon.com/robomaker/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-robomaker-robotapplicationversion.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const robotapplicationversion = await AWS.RoboMaker.RobotApplicationVersion(
  "robotapplicationversion-example",
  { Application: "example-application" }
);
```

