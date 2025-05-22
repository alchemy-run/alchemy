---
title: Managing AWS Alexa ASKs with Alchemy
description: Learn how to create, update, and manage AWS Alexa ASKs using Alchemy Cloud Control.
---

# ASK

The ASK resource lets you create and manage [AWS Alexa ASKs](https://docs.aws.amazon.com/alexa/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ask-skill.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const ask = await AWS.Alexa.ASK("ask-example", {
  AuthenticationConfiguration: "example-authenticationconfiguration",
  VendorId: "example-vendorid",
  SkillPackage: "example-skillpackage",
});
```

