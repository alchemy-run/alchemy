<!-- Docs for the generated AWS.BedrockDataAutomation bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## CopyBlueprintStage

Runtime binding for the `CopyBlueprintStage` operation (IAM action
`bedrock:CopyBlueprintStage` on the blueprint ARN) — copy the bound
blueprint between its `DEVELOPMENT` and `LIVE` stages from a deployed
Function (e.g. promote a tuned development schema to live).

Provide the implementation with
`Effect.provide(AWS.BedrockDataAutomation.CopyBlueprintStageHttp)`.
### Blueprint Management
**Example:** Promote Development To Live
```typescript
// deploy time — bind the blueprint
const copyStage =
  yield* AWS.BedrockDataAutomation.CopyBlueprintStage(blueprint);

// runtime — promote the development copy
yield* copyStage({ sourceStage: "DEVELOPMENT", targetStage: "LIVE" });
```

@binding

## CopyBlueprintStage.Request

`CopyBlueprintStage` request with `blueprintArn` injected from the bound
{@link Blueprint}.

## CreateBlueprintVersion

Runtime binding for the `CreateBlueprintVersion` operation (IAM action
`bedrock:CreateBlueprintVersion` on the blueprint ARN) — snapshot the
bound blueprint's current schema as an immutable version from a deployed
Function.

Provide the implementation with
`Effect.provide(AWS.BedrockDataAutomation.CreateBlueprintVersionHttp)`.
### Blueprint Management
**Example:** Snapshot The Blueprint
```typescript
// deploy time — bind the blueprint
const createVersion =
  yield* AWS.BedrockDataAutomation.CreateBlueprintVersion(blueprint);

// runtime — freeze the current schema as a new version
const { blueprint: version } = yield* createVersion({});
yield* Effect.log(`created version ${version.blueprintVersion}`);
```

@binding

## CreateBlueprintVersion.Request

`CreateBlueprintVersion` request with `blueprintArn` injected from the
bound {@link Blueprint}.

## GetBlueprintOptimizationStatus

Runtime binding for the `GetBlueprintOptimizationStatus` operation (IAM
action `bedrock:GetBlueprintOptimizationStatus` on `*` — optimization
invocation ARNs are minted at runtime) — poll the status of a blueprint
optimization job started by `InvokeBlueprintOptimizationAsync`.

Provide the implementation with
`Effect.provide(AWS.BedrockDataAutomation.GetBlueprintOptimizationStatusHttp)`.
### Blueprint Optimization
**Example:** Poll An Optimization Job
```typescript
// deploy time — account-level binding
const getStatus =
  yield* AWS.BedrockDataAutomation.GetBlueprintOptimizationStatus();

// runtime — poll the invocation returned by InvokeBlueprintOptimizationAsync
const { status, outputConfiguration } = yield* getStatus({ invocationArn });
if (status === "Success") {
  yield* Effect.log(
    `optimized schema at ${outputConfiguration?.s3Object.s3Uri}`,
  );
}
```

@binding

## GetDataAutomationLibraryEntity

Runtime binding for the `GetDataAutomationLibraryEntity` operation (IAM
action `bedrock:GetDataAutomationLibraryEntity` on the library ARN) —
read a single entity (e.g. a `VOCABULARY` entry with its phrases) from the
bound library.

Provide the implementation with
`Effect.provide(AWS.BedrockDataAutomation.GetDataAutomationLibraryEntityHttp)`.
### Library Entities
**Example:** Read A Vocabulary Entity
```typescript
// deploy time — bind the library
const getEntity =
  yield* AWS.BedrockDataAutomation.GetDataAutomationLibraryEntity(library);

// runtime — fetch the entity written by an ingestion job
const { entity } = yield* getEntity({
  entityType: "VOCABULARY",
  entityId,
});
```

@binding

## GetDataAutomationLibraryEntity.Request

`GetDataAutomationLibraryEntity` request with `libraryArn` injected from
the bound {@link DataAutomationLibrary}.

## GetDataAutomationStatus

Runtime binding for the `GetDataAutomationStatus` operation (IAM action
`bedrock:GetDataAutomationStatus` on `*` — invocation ARNs are minted at
runtime) — poll the status of an asynchronous Bedrock Data Automation job
from a deployed Function.

Provide the implementation with
`Effect.provide(AWS.BedrockDataAutomation.GetDataAutomationStatusHttp)`.
### Polling Job Status
**Example:** Check An Async Job's Status
```typescript
// deploy time — account-level binding
const getStatus = yield* AWS.BedrockDataAutomation.GetDataAutomationStatus();

// runtime — poll the invocation returned by InvokeDataAutomationAsync
const { status, outputConfiguration } = yield* getStatus({ invocationArn });
if (status === "Success") {
  yield* Effect.log(`results at ${outputConfiguration?.s3Uri}`);
}
```

@binding

## InvokeBlueprintOptimizationAsync

Runtime binding for the `InvokeBlueprintOptimizationAsync` operation (IAM
action `bedrock:InvokeBlueprintOptimizationAsync` on the blueprint ARN +
the account's data automation profiles) — start an asynchronous job that
tunes the bound blueprint's schema against labeled samples (asset +
ground-truth pairs in S3) from a deployed Function.

The samples and output location are read/written with the caller's S3
permissions. Poll the returned invocation with the
`GetBlueprintOptimizationStatus` binding. Provide the implementation with
`Effect.provide(AWS.BedrockDataAutomation.InvokeBlueprintOptimizationAsyncHttp)`.
### Blueprint Optimization
**Example:** Optimize A Blueprint Against Labeled Samples
```typescript
// deploy time — bind the blueprint
const optimize =
  yield* AWS.BedrockDataAutomation.InvokeBlueprintOptimizationAsync(blueprint);

// runtime — start the optimization job
const { invocationArn } = yield* optimize({
  samples: [
    {
      assetS3Object: { s3Uri: `s3://${bucket}/samples/invoice-1.pdf` },
      groundTruthS3Object: { s3Uri: `s3://${bucket}/samples/invoice-1.json` },
    },
  ],
  outputConfiguration: {
    s3Object: { s3Uri: `s3://${bucket}/optimization-results/` },
  },
  dataAutomationProfileArn: profileArn,
});
```

@binding

## InvokeBlueprintOptimizationAsync.Request

`InvokeBlueprintOptimizationAsync` request with the `blueprint` object
(ARN + stage) injected from the bound {@link Blueprint}.

## InvokeDataAutomation

Runtime binding for the synchronous `InvokeDataAutomation` operation (IAM
action `bedrock:InvokeDataAutomation` on the project ARN + the account's
data automation profiles) — process a file inline against the bound
project from a deployed Function and get the extracted output back in the
response.

The bound {@link DataAutomationProject} must be created with
`projectType: "SYNC"`. Input can be passed inline as `bytes` or as an
`s3Uri`; the caller supplies the cross-region data automation profile ARN
(e.g. `…:data-automation-profile/us.data-automation-v1`). Provide the
implementation with
`Effect.provide(AWS.BedrockDataAutomation.InvokeDataAutomationHttp)`.
### Invoking Data Automation
**Example:** Extract Fields From An Inline Document
```typescript
// deploy time — bind the SYNC project
const invoke = yield* AWS.BedrockDataAutomation.InvokeDataAutomation(syncProject);

// runtime — process request bytes synchronously
const result = yield* invoke({
  inputConfiguration: { bytes: documentBytes },
  dataAutomationProfileArn: profileArn,
});
const fields = result.outputSegments?.[0]?.customOutput;
```

@binding

## InvokeDataAutomation.Request

`InvokeDataAutomation` request with `dataAutomationConfiguration`
(project ARN + stage) injected from the bound
{@link DataAutomationProject}.

## InvokeDataAutomationAsync

Runtime binding for the `InvokeDataAutomationAsync` operation (IAM action
`bedrock:InvokeDataAutomationAsync` on the project ARN + the account's
data automation profiles) — start an asynchronous Bedrock Data Automation
job against the bound project from a deployed Function.

The binding is constructed with the target {@link DataAutomationProject};
its ARN and stage are injected into every runtime request as
`dataAutomationConfiguration`. The caller supplies the S3 input/output
locations and the cross-region data automation profile ARN (e.g.
`arn:aws:bedrock:us-west-2:{account}:data-automation-profile/us.data-automation-v1`).
The calling role also needs `s3:GetObject` on the input and `s3:PutObject`
on the output location — Bedrock Data Automation accesses S3 with the
caller's permissions. Provide the implementation with
`Effect.provide(AWS.BedrockDataAutomation.InvokeDataAutomationAsyncHttp)`.
### Invoking Data Automation
**Example:** Start An Async Job For An Uploaded Document
```typescript
// deploy time — bind the project
const invokeAsync = yield* AWS.BedrockDataAutomation.InvokeDataAutomationAsync(project);

// runtime — process a document already in S3
const { invocationArn } = yield* invokeAsync({
  inputConfiguration: { s3Uri: `s3://${bucket}/uploads/invoice.pdf` },
  outputConfiguration: { s3Uri: `s3://${bucket}/results/` },
  dataAutomationProfileArn: profileArn,
});
```

**Example:** Get Notified Via EventBridge When The Job Settles
```typescript
yield* invokeAsync({
  inputConfiguration: { s3Uri: input },
  outputConfiguration: { s3Uri: output },
  dataAutomationProfileArn: profileArn,
  notificationConfiguration: {
    eventBridgeConfiguration: { eventBridgeEnabled: true },
  },
});
// pair with AWS.BedrockDataAutomation.consumeDataAutomationJobEvents
```

@binding

## InvokeDataAutomationAsync.Request

`InvokeDataAutomationAsync` request with `dataAutomationConfiguration`
(project ARN + stage) injected from the bound
{@link DataAutomationProject}.

## ListDataAutomationLibraryEntities

Runtime binding for the `ListDataAutomationLibraryEntities` operation (IAM
action `bedrock:ListDataAutomationLibraryEntities` on the library ARN) —
page through the bound library's entities of a given type from a deployed
Function.

Provide the implementation with
`Effect.provide(AWS.BedrockDataAutomation.ListDataAutomationLibraryEntitiesHttp)`.
### Library Entities
**Example:** List Vocabulary Entities
```typescript
// deploy time — bind the library
const listEntities =
  yield* AWS.BedrockDataAutomation.ListDataAutomationLibraryEntities(library);

// runtime — first page of vocabulary entities
const { entities } = yield* listEntities({
  entityType: "VOCABULARY",
  maxResults: 25,
});
```

@binding

## ListDataAutomationLibraryEntities.Request

`ListDataAutomationLibraryEntities` request with `libraryArn` injected
from the bound {@link DataAutomationLibrary}.
