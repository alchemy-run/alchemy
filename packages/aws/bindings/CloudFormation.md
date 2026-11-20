<!-- Docs for the generated AWS.CloudFormation bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## DescribeStackDriftDetectionStatus

Runtime binding for the `DescribeStackDriftDetectionStatus` operation (IAM
action `cloudformation:DescribeStackDriftDetectionStatus` on `*` — the
detection id is not resource-scoped).

Polls a drift-detection run started with {@link DetectStackDrift} until it
reaches `DETECTION_COMPLETE` / `DETECTION_FAILED` and reports the stack's
overall drift status. Provide the implementation with
`Effect.provide(AWS.CloudFormation.DescribeStackDriftDetectionStatusHttp)`.
### Drift Detection
**Example:** Poll a Drift Detection Run
```typescript
const describeStackDriftDetectionStatus =
  yield* AWS.CloudFormation.DescribeStackDriftDetectionStatus();

const status = yield* describeStackDriftDetectionStatus({
  StackDriftDetectionId: detectionId,
});
// status.DetectionStatus, status.StackDriftStatus
```

@binding

## DescribeStackEvents

Runtime binding for the `DescribeStackEvents` operation (IAM action
`cloudformation:DescribeStackEvents`).

Bind this operation to a {@link Stack} to read its event history —
per-resource create/update/delete progress and failure reasons — from
inside a function runtime. Useful for deployment dashboards and failure
alerting. Provide the implementation with
`Effect.provide(AWS.CloudFormation.DescribeStackEventsHttp)`.
### Reading Stacks
**Example:** Read Recent Stack Events
```typescript
const describeStackEvents =
  yield* AWS.CloudFormation.DescribeStackEvents(stack);

const { StackEvents } = yield* describeStackEvents();
const failures = (StackEvents ?? []).filter(
  (e) => e.ResourceStatus?.endsWith("_FAILED"),
);
```

@binding

## DescribeStackResourceDrifts

Runtime binding for the `DescribeStackResourceDrifts` operation (IAM action
`cloudformation:DescribeStackResourceDrifts`).

Bind this operation to a {@link Stack} to read per-resource drift results
after a {@link DetectStackDrift} run — which resources were `MODIFIED` or
`DELETED` out-of-band and the actual-vs-expected property differences.
Provide the implementation with
`Effect.provide(AWS.CloudFormation.DescribeStackResourceDriftsHttp)`.
### Drift Detection
**Example:** Read Drifted Resources
```typescript
const describeStackResourceDrifts =
  yield* AWS.CloudFormation.DescribeStackResourceDrifts(stack);

const { StackResourceDrifts } = yield* describeStackResourceDrifts({
  StackResourceDriftStatusFilters: ["MODIFIED", "DELETED"],
});
```

@binding

## DescribeStackResources

Runtime binding for the `DescribeStackResources` operation (IAM action
`cloudformation:DescribeStackResources`).

Bind this operation to a {@link Stack} to resolve the physical ids of the
stack's resources — e.g. look up a resource created by the template by its
logical id from inside a function runtime. Provide the implementation with
`Effect.provide(AWS.CloudFormation.DescribeStackResourcesHttp)`.
### Reading Stack Resources
**Example:** Resolve a Resource's Physical Id
```typescript
const describeStackResources =
  yield* AWS.CloudFormation.DescribeStackResources(stack);

const { StackResources } = yield* describeStackResources({
  LogicalResourceId: "Param",
});
const physicalId = StackResources?.[0]?.PhysicalResourceId;
```

@binding

## DescribeStacks

Runtime binding for the `DescribeStacks` operation (IAM action
`cloudformation:DescribeStacks`).

Bind this operation to a {@link Stack} to read its live status, parameters,
and template outputs from inside a function runtime — the classic
service-discovery pattern of resolving endpoints/ARNs from a stack's
outputs. Provide the implementation with
`Effect.provide(AWS.CloudFormation.DescribeStacksHttp)`.
### Reading Stacks
**Example:** Read a Stack's Outputs
```typescript
// init — bind the operation to the stack
const describeStacks = yield* AWS.CloudFormation.DescribeStacks(stack);

// runtime
const { Stacks } = yield* describeStacks();
const outputs = Stacks?.[0]?.Outputs ?? [];
```

@binding

## DetectStackDrift

Runtime binding for the `DetectStackDrift` operation (IAM actions
`cloudformation:DetectStackDrift` + `cloudformation:DetectStackResourceDrift`
— AWS authorizes both on the per-stack call).

Bind this operation to a {@link Stack} to start drift detection from inside
a function runtime — e.g. a scheduled drift monitor. Detection runs
asynchronously; poll the returned `StackDriftDetectionId` with
{@link DescribeStackDriftDetectionStatus}. Note that CloudFormation reads
the live state of the stack's resources with the caller's credentials, so
the function also needs read access to the resource types in the template
for the detection to complete. Provide the implementation with
`Effect.provide(AWS.CloudFormation.DetectStackDriftHttp)`.
### Drift Detection
**Example:** Start Drift Detection
```typescript
const detectStackDrift = yield* AWS.CloudFormation.DetectStackDrift(stack);

const { StackDriftDetectionId } = yield* detectStackDrift();
```

@binding

## GetTemplate

Runtime binding for the `GetTemplate` operation (IAM action
`cloudformation:GetTemplate`).

Bind this operation to a {@link Stack} to read the deployed template body
from inside a function runtime — e.g. audit tooling that archives or diffs
the template actually running in the account. Provide the implementation
with `Effect.provide(AWS.CloudFormation.GetTemplateHttp)`.
### Reading Stacks
**Example:** Read the Deployed Template
```typescript
const getTemplate = yield* AWS.CloudFormation.GetTemplate(stack);

const { TemplateBody } = yield* getTemplate();
```

@binding

## ListExports

Runtime binding for the `ListExports` operation (IAM action
`cloudformation:ListExports` on `*` — exports are account-scoped).

Lists all cross-stack exported output values in the account and region —
runtime service discovery of values shared via `Fn::ImportValue`. Provide
the implementation with `Effect.provide(AWS.CloudFormation.ListExportsHttp)`.
### Cross-Stack Exports
**Example:** Resolve an Exported Value
```typescript
const listExports = yield* AWS.CloudFormation.ListExports();

const { Exports } = yield* listExports();
const apiUrl = Exports?.find((e) => e.Name === "ApiUrl")?.Value;
```

@binding

## ListImports

Runtime binding for the `ListImports` operation (IAM action
`cloudformation:ListImports` on `*` — imports are account-scoped).

Lists the stacks importing a given exported output value — e.g. impact
analysis before rotating a shared value. Provide the implementation with
`Effect.provide(AWS.CloudFormation.ListImportsHttp)`.
### Cross-Stack Exports
**Example:** Find Stacks Importing an Export
```typescript
const listImports = yield* AWS.CloudFormation.ListImports();

const { Imports } = yield* listImports({ ExportName: "ApiUrl" });
```

@binding

## ListStackResources

Runtime binding for the `ListStackResources` operation (IAM action
`cloudformation:ListStackResources`).

Bind this operation to a {@link Stack} to enumerate all of the stack's
resource summaries (paginated) from inside a function runtime — the
lighter-weight alternative to `DescribeStackResources` for stacks with many
resources. Provide the implementation with
`Effect.provide(AWS.CloudFormation.ListStackResourcesHttp)`.
### Reading Stack Resources
**Example:** Enumerate Stack Resources
```typescript
const listStackResources =
  yield* AWS.CloudFormation.ListStackResources(stack);

const { StackResourceSummaries } = yield* listStackResources();
const types = (StackResourceSummaries ?? []).map((r) => r.ResourceType);
```

@binding

## SignalResource

Runtime binding for the `SignalResource` operation (IAM action
`cloudformation:SignalResource`).

Bind this operation to a {@link Stack} to send SUCCESS/FAILURE signals to a
resource with a `CreationPolicy` or a `WaitCondition` in the stack —
e.g. a function that performs out-of-band initialization and unblocks the
stack when done. Provide the implementation with
`Effect.provide(AWS.CloudFormation.SignalResourceHttp)`.
### Signaling Resources
**Example:** Signal a Wait Condition
```typescript
const signalResource = yield* AWS.CloudFormation.SignalResource(stack);

yield* signalResource({
  LogicalResourceId: "WaitCondition",
  UniqueId: "init-1",
  Status: "SUCCESS",
});
```

@binding

## ValidateTemplate

Runtime binding for the `ValidateTemplate` operation (IAM action
`cloudformation:ValidateTemplate` on `*` — validation is not
resource-scoped).

Validates a template body or URL and reports its parameters, capabilities,
and declaration errors — e.g. a platform service that lints user-submitted
templates before deploying them. Provide the implementation with
`Effect.provide(AWS.CloudFormation.ValidateTemplateHttp)`.
### Validating Templates
**Example:** Validate a Template Body
```typescript
const validateTemplate = yield* AWS.CloudFormation.ValidateTemplate();

const { Parameters, Capabilities } = yield* validateTemplate({
  TemplateBody: templateJson,
});
```

@binding
