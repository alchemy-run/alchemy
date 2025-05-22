---
title: Managing AWS WAFv2 RegexPatternSets with Alchemy
description: Learn how to create, update, and manage AWS WAFv2 RegexPatternSets using Alchemy Cloud Control.
---

# RegexPatternSet

The RegexPatternSet resource lets you create and manage [AWS WAFv2 RegexPatternSets](https://docs.aws.amazon.com/wafv2/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-wafv2-regexpatternset.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const regexpatternset = await AWS.WAFv2.RegexPatternSet("regexpatternset-example", {
  RegularExpressionList: ["example-regularexpressionlist-1"],
  Scope: "example-scope",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A regexpatternset resource managed by Alchemy",
});
```

## Advanced Configuration

Create a regexpatternset with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedRegexPatternSet = await AWS.WAFv2.RegexPatternSet("advanced-regexpatternset", {
  RegularExpressionList: ["example-regularexpressionlist-1"],
  Scope: "example-scope",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A regexpatternset resource managed by Alchemy",
});
```

