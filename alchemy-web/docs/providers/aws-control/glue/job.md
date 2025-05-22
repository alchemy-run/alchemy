---
title: Managing AWS Glue Jobs with Alchemy
description: Learn how to create, update, and manage AWS Glue Jobs using Alchemy Cloud Control.
---

# Job

The Job resource lets you create and manage [AWS Glue Jobs](https://docs.aws.amazon.com/glue/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-glue-job.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const job = await AWS.Glue.Job("job-example", {
  Role: "example-role",
  Command: "example-command",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A job resource managed by Alchemy",
});
```

## Advanced Configuration

Create a job with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedJob = await AWS.Glue.Job("advanced-job", {
  Role: "example-role",
  Command: "example-command",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A job resource managed by Alchemy",
});
```

