<!-- Docs for the generated AWS.Config bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## BatchGetResourceConfig

Runtime binding for `config:BatchGetResourceConfig` — fetch the current
configuration item for up to 100 recorded resources identified by
resource keys. Keys the recorder has not discovered come back in
`unprocessedResourceKeys`.

Provide `Config.BatchGetResourceConfigHttp` on the hosting Lambda Function to
satisfy the requirement.
### Reading Resource Configurations
**Example:** Batch-Read Current Configurations
```typescript
// init — grants config:BatchGetResourceConfig
const batchGetResourceConfig = yield* AWS.Config.BatchGetResourceConfig();

// runtime
const result = yield* batchGetResourceConfig({
  resourceKeys: [
    { resourceType: "AWS::S3::Bucket", resourceId: "my-bucket" },
  ],
});
console.log(result.baseConfigurationItems);
```

@binding

## DeleteResourceConfig

Runtime binding for `config:DeleteResourceConfig` — delete the recorded
configuration of a custom (third-party) resource previously recorded via
`PutResourceConfig`.

Provide `Config.DeleteResourceConfigHttp` on the hosting Lambda Function to
satisfy the requirement.
### Recording Custom Resources
**Example:** Delete a Custom Resource's Configuration
```typescript
// init — grants config:DeleteResourceConfig
const deleteResourceConfig = yield* AWS.Config.DeleteResourceConfig();

// runtime
yield* deleteResourceConfig({
  ResourceType: "MyCompany::Service::Widget",
  ResourceId: "widget-1",
});
```

@binding

## DeliverConfigSnapshot

Runtime binding for `config:DeliverConfigSnapshot` — trigger an on-demand
delivery of a configuration snapshot to the bound
{@link DeliveryChannel}'s S3 bucket; the channel name is injected
automatically. Requires a running configuration recorder.

Provide `Config.DeliverConfigSnapshotHttp` on the hosting Lambda Function
to satisfy the requirement.
### Delivering Snapshots
**Example:** Deliver a Snapshot On Demand
```typescript
// init — grants config:DeliverConfigSnapshot
const deliverSnapshot = yield* AWS.Config.DeliverConfigSnapshot(channel);

// runtime
const result = yield* deliverSnapshot();
console.log(result.configSnapshotId);
```

@binding

## DescribeComplianceByConfigRule

Runtime binding for `config:DescribeComplianceByConfigRule` — read
whether your Config rules are compliant (and how many resources violate
each noncompliant rule).

Provide `Config.DescribeComplianceByConfigRuleHttp` on the hosting Lambda Function to
satisfy the requirement.
### Reading Compliance
**Example:** Check Rule Compliance
```typescript
// init — grants config:DescribeComplianceByConfigRule
const describeComplianceByConfigRule = yield* AWS.Config.DescribeComplianceByConfigRule();

// runtime
const result = yield* describeComplianceByConfigRule();
for (const rule of result.ComplianceByConfigRules ?? []) {
  console.log(rule.ConfigRuleName, rule.Compliance?.ComplianceType);
}
```

@binding

## DescribeComplianceByResource

Runtime binding for `config:DescribeComplianceByResource` — read whether
evaluated resources comply with the Config rules that evaluate them.

Provide `Config.DescribeComplianceByResourceHttp` on the hosting Lambda Function to
satisfy the requirement.
### Reading Compliance
**Example:** Check Resource Compliance
```typescript
// init — grants config:DescribeComplianceByResource
const describeComplianceByResource = yield* AWS.Config.DescribeComplianceByResource();

// runtime
const result = yield* describeComplianceByResource({
  ResourceType: "AWS::S3::Bucket",
});
console.log(result.ComplianceByResources);
```

@binding

## DescribeConfigRuleEvaluationStatus

Runtime binding for `config:DescribeConfigRuleEvaluationStatus` — read
the evaluation status (last invocation, last failure, first-evaluation
flag) of your Config rules.

Provide `Config.DescribeConfigRuleEvaluationStatusHttp` on the hosting Lambda Function to
satisfy the requirement.
### Rule Evaluation Status
**Example:** Read Rule Evaluation Status
```typescript
// init — grants config:DescribeConfigRuleEvaluationStatus
const describeConfigRuleEvaluationStatus = yield* AWS.Config.DescribeConfigRuleEvaluationStatus();

// runtime
const result = yield* describeConfigRuleEvaluationStatus();
for (const status of result.ConfigRulesEvaluationStatus ?? []) {
  console.log(status.ConfigRuleName, status.LastSuccessfulInvocationTime);
}
```

@binding

## GetComplianceDetailsByConfigRule

Runtime binding for `config:GetComplianceDetailsByConfigRule` — read the
per-resource evaluation results (who was evaluated, when, and the
verdict) of the bound {@link ConfigRule}; the rule name is injected
automatically.

Provide `Config.GetComplianceDetailsByConfigRuleHttp` on the hosting
Lambda Function to satisfy the requirement.
### Reading Compliance
**Example:** Read a Rule's Evaluation Results
```typescript
// init — grants config:GetComplianceDetailsByConfigRule
const getComplianceDetails =
  yield* AWS.Config.GetComplianceDetailsByConfigRule(rule);

// runtime
const result = yield* getComplianceDetails({
  ComplianceTypes: ["NON_COMPLIANT"],
});
console.log(result.EvaluationResults);
```

@binding

## GetComplianceDetailsByConfigRule.Request

Request for {@link GetComplianceDetailsByConfigRule} — the rule name is injected from the bound rule.

## GetComplianceDetailsByResource

Runtime binding for `config:GetComplianceDetailsByResource` — read the
per-rule evaluation results (who evaluated the resource, when, and the
verdict) for one resource.

Provide `Config.GetComplianceDetailsByResourceHttp` on the hosting Lambda Function to
satisfy the requirement.
### Reading Compliance
**Example:** Read a Resource's Evaluation Results
```typescript
// init — grants config:GetComplianceDetailsByResource
const getComplianceDetailsByResource = yield* AWS.Config.GetComplianceDetailsByResource();

// runtime
const result = yield* getComplianceDetailsByResource({
  ResourceType: "AWS::S3::Bucket",
  ResourceId: "my-bucket",
});
console.log(result.EvaluationResults);
```

@binding

## GetComplianceSummaryByConfigRule

Runtime binding for `config:GetComplianceSummaryByConfigRule` — read the
account-wide count of compliant vs. noncompliant Config rules.

Provide `Config.GetComplianceSummaryByConfigRuleHttp` on the hosting Lambda Function to
satisfy the requirement.
### Reading Compliance
**Example:** Summarize Rule Compliance
```typescript
// init — grants config:GetComplianceSummaryByConfigRule
const getComplianceSummaryByConfigRule = yield* AWS.Config.GetComplianceSummaryByConfigRule();

// runtime
const result = yield* getComplianceSummaryByConfigRule();
console.log(result.ComplianceSummary?.NonCompliantResourceCount);
```

@binding

## GetComplianceSummaryByResourceType

Runtime binding for `config:GetComplianceSummaryByResourceType` — read
the count of compliant vs. noncompliant resources, optionally grouped by
resource type.

Provide `Config.GetComplianceSummaryByResourceTypeHttp` on the hosting Lambda Function to
satisfy the requirement.
### Reading Compliance
**Example:** Summarize Resource Compliance
```typescript
// init — grants config:GetComplianceSummaryByResourceType
const getComplianceSummaryByResourceType = yield* AWS.Config.GetComplianceSummaryByResourceType();

// runtime
const result = yield* getComplianceSummaryByResourceType();
console.log(result.ComplianceSummariesByResourceType);
```

@binding

## GetDiscoveredResourceCounts

Runtime binding for `config:GetDiscoveredResourceCounts` — count the
resources AWS Config has discovered, grouped by resource type.

Provide `Config.GetDiscoveredResourceCountsHttp` on the hosting Lambda Function to
satisfy the requirement.
### Discovering Resources
**Example:** Count Discovered Resources
```typescript
// init — grants config:GetDiscoveredResourceCounts
const getDiscoveredResourceCounts = yield* AWS.Config.GetDiscoveredResourceCounts();

// runtime
const result = yield* getDiscoveredResourceCounts();
console.log(result.totalDiscoveredResources, result.resourceCounts);
```

@binding

## GetResourceConfigHistory

Runtime binding for `config:GetResourceConfigHistory` — read the list of
configuration items (change history) AWS Config recorded for a resource,
newest first.

Provide `Config.GetResourceConfigHistoryHttp` on the hosting Lambda Function to
satisfy the requirement.
### Reading Resource Configurations
**Example:** Read a Resource's Configuration History
```typescript
// init — grants config:GetResourceConfigHistory
const getResourceConfigHistory = yield* AWS.Config.GetResourceConfigHistory();

// runtime
const result = yield* getResourceConfigHistory({
  resourceType: "AWS::S3::Bucket",
  resourceId: "my-bucket",
  limit: 10,
});
console.log(result.configurationItems?.length);
```

@binding

## GetResourceEvaluationSummary

Runtime binding for `config:GetResourceEvaluationSummary` — read the
status and compliance verdict of a proactive resource evaluation started
with `StartResourceEvaluation`.

Provide `Config.GetResourceEvaluationSummaryHttp` on the hosting Lambda Function to
satisfy the requirement.
### Proactive Resource Evaluation
**Example:** Read an Evaluation's Summary
```typescript
// init — grants config:GetResourceEvaluationSummary
const getResourceEvaluationSummary = yield* AWS.Config.GetResourceEvaluationSummary();

// runtime
const result = yield* getResourceEvaluationSummary({
  ResourceEvaluationId: evaluationId,
});
console.log(result.EvaluationStatus?.Status, result.Compliance);
```

@binding

## ListDiscoveredResources

Runtime binding for `config:ListDiscoveredResources` — enumerate the
resource identifiers (type, id, name) AWS Config has discovered for a
resource type, including optionally deleted resources.

Provide `Config.ListDiscoveredResourcesHttp` on the hosting Lambda Function to
satisfy the requirement.
### Discovering Resources
**Example:** List Discovered Buckets
```typescript
// init — grants config:ListDiscoveredResources
const listDiscoveredResources = yield* AWS.Config.ListDiscoveredResources();

// runtime
const result = yield* listDiscoveredResources({
  resourceType: "AWS::S3::Bucket",
});
console.log(result.resourceIdentifiers);
```

@binding

## ListResourceEvaluations

Runtime binding for `config:ListResourceEvaluations` — enumerate the
proactive resource evaluations run in the account, optionally filtered
by evaluation mode and time window.

Provide `Config.ListResourceEvaluationsHttp` on the hosting Lambda Function to
satisfy the requirement.
### Proactive Resource Evaluation
**Example:** List Proactive Evaluations
```typescript
// init — grants config:ListResourceEvaluations
const listResourceEvaluations = yield* AWS.Config.ListResourceEvaluations();

// runtime
const result = yield* listResourceEvaluations({
  Filters: { EvaluationMode: "PROACTIVE" },
});
console.log(result.ResourceEvaluations);
```

@binding

## PutEvaluations

Runtime binding for `config:PutEvaluations` — report evaluation results
to AWS Config from inside a custom Config rule's Lambda function, using
the `resultToken` the rule invocation delivered.

Provide `Config.PutEvaluationsHttp` on the hosting Lambda Function to
satisfy the requirement.
### Reporting Evaluations (Custom Rules)
**Example:** Report Evaluations from a Custom Rule
```typescript
// init — grants config:PutEvaluations
const putEvaluations = yield* AWS.Config.PutEvaluations();

// runtime
const result = yield* putEvaluations({
  ResultToken: event.resultToken,
  Evaluations: [
    {
      ComplianceResourceType: "AWS::S3::Bucket",
      ComplianceResourceId: "my-bucket",
      ComplianceType: "COMPLIANT",
      OrderingTimestamp: new Date(),
    },
  ],
});
console.log(result.FailedEvaluations);
```

@binding

## PutExternalEvaluation

Runtime binding for `config:PutExternalEvaluation` — push an externally
computed compliance verdict for one resource into the bound
{@link ConfigRule} (the rule must use the external evaluation mode); the
rule name is injected automatically.

Provide `Config.PutExternalEvaluationHttp` on the hosting Lambda Function
to satisfy the requirement.
### Reporting Evaluations (Custom Rules)
**Example:** Push an External Evaluation
```typescript
// init — grants config:PutExternalEvaluation
const putExternalEvaluation = yield* AWS.Config.PutExternalEvaluation(rule);

// runtime
yield* putExternalEvaluation({
  ExternalEvaluation: {
    ComplianceResourceType: "AWS::S3::Bucket",
    ComplianceResourceId: "my-bucket",
    ComplianceType: "COMPLIANT",
    OrderingTimestamp: new Date(),
  },
});
```

@binding

## PutExternalEvaluation.Request

Request for {@link PutExternalEvaluation} — the rule name is injected from the bound rule.

## PutResourceConfig

Runtime binding for `config:PutResourceConfig` — record the
configuration item of a custom (third-party) resource type with AWS
Config, e.g. `MyCompany::Service::Widget`.

Provide `Config.PutResourceConfigHttp` on the hosting Lambda Function to
satisfy the requirement.
### Recording Custom Resources
**Example:** Record a Custom Resource
```typescript
// init — grants config:PutResourceConfig
const putResourceConfig = yield* AWS.Config.PutResourceConfig();

// runtime
yield* putResourceConfig({
  ResourceType: "MyCompany::Service::Widget",
  SchemaVersionId: "1.0",
  ResourceId: "widget-1",
  Configuration: JSON.stringify({ color: "teal" }),
});
```

@binding

## SelectResourceConfig

Runtime binding for `config:SelectResourceConfig` — run a SQL `SELECT`
query (AWS Config advanced query) against the current configuration
state of recorded resources.

Provide `Config.SelectResourceConfigHttp` on the hosting Lambda Function to
satisfy the requirement.
### Querying with SQL
**Example:** Query Resource State with SQL
```typescript
// init — grants config:SelectResourceConfig
const selectResourceConfig = yield* AWS.Config.SelectResourceConfig();

// runtime
const result = yield* selectResourceConfig({
  Expression:
    "SELECT resourceId WHERE resourceType = 'AWS::S3::Bucket'",
});
console.log(result.Results);
```

@binding

## StartConfigRulesEvaluation

Runtime binding for `config:StartConfigRulesEvaluation` — run an
on-demand evaluation of the bound {@link ConfigRule} against the last
known configuration state of your resources; the rule name is injected
automatically.

Provide `Config.StartConfigRulesEvaluationHttp` on the hosting Lambda
Function to satisfy the requirement.
### Rule Evaluation Status
**Example:** Re-Evaluate a Rule On Demand
```typescript
// init — grants config:StartConfigRulesEvaluation
const startRulesEvaluation =
  yield* AWS.Config.StartConfigRulesEvaluation(rule);

// runtime
yield* startRulesEvaluation();
```

@binding

## StartResourceEvaluation

Runtime binding for `config:StartResourceEvaluation` — proactively
evaluate a hypothetical resource configuration against your PROACTIVE
Config rules before the resource is deployed.

Provide `Config.StartResourceEvaluationHttp` on the hosting Lambda Function to
satisfy the requirement.
### Proactive Resource Evaluation
**Example:** Evaluate a Resource Before Deploying
```typescript
// init — grants config:StartResourceEvaluation
const startResourceEvaluation = yield* AWS.Config.StartResourceEvaluation();

// runtime
const result = yield* startResourceEvaluation({
  EvaluationMode: "PROACTIVE",
  ResourceDetails: {
    ResourceId: "my-bucket",
    ResourceType: "AWS::S3::Bucket",
    ResourceConfiguration: JSON.stringify({
      BucketName: "my-bucket",
    }),
    ResourceConfigurationSchemaType: "CFN_RESOURCE_SCHEMA",
  },
});
console.log(result.ResourceEvaluationId);
```

@binding
