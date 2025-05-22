---
title: Managing AWS LookoutVision Projects with Alchemy
description: Learn how to create, update, and manage AWS LookoutVision Projects using Alchemy Cloud Control.
---

# Project

The Project resource lets you create and manage [AWS LookoutVision Projects](https://docs.aws.amazon.com/lookoutvision/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-lookoutvision-project.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const project = await AWS.LookoutVision.Project("project-example", {
  ProjectName: "project-project",
});
```

