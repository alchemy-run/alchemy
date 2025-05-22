---
title: Managing AWS SSM Associations with Alchemy
description: Learn how to create, update, and manage AWS SSM Associations using Alchemy Cloud Control.
---

# Association

The Association resource lets you create and manage [AWS SSM Associations](https://docs.aws.amazon.com/ssm/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ssm-association.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const association = await AWS.SSM.Association("association-example", { Name: "association-" });
```

