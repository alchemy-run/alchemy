---
title: Managing AWS Deadline MeteredProducts with Alchemy
description: Learn how to create, update, and manage AWS Deadline MeteredProducts using Alchemy Cloud Control.
---

# MeteredProduct

The MeteredProduct resource lets you create and manage [AWS Deadline MeteredProducts](https://docs.aws.amazon.com/deadline/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-deadline-meteredproduct.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const meteredproduct = await AWS.Deadline.MeteredProduct("meteredproduct-example", {});
```

