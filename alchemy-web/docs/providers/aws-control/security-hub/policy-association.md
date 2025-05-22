---
title: Managing AWS SecurityHub PolicyAssociations with Alchemy
description: Learn how to create, update, and manage AWS SecurityHub PolicyAssociations using Alchemy Cloud Control.
---

# PolicyAssociation

The PolicyAssociation resource lets you create and manage [AWS SecurityHub PolicyAssociations](https://docs.aws.amazon.com/securityhub/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-securityhub-policyassociation.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const policyassociation = await AWS.SecurityHub.PolicyAssociation("policyassociation-example", {
  ConfigurationPolicyId: "example-configurationpolicyid",
  TargetType: "example-targettype",
  TargetId: "example-targetid",
});
```

