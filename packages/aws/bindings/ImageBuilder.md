<!-- Docs for the generated AWS.ImageBuilder bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## CancelImageCreation

Runtime binding for `imagebuilder:CancelImageCreation`.

Cancels an in-flight image build (only valid for builds in a non-terminal
state). Build versions are created dynamically by pipeline runs, so this
is an account-level binding: pass the `imageBuildVersionArn` returned by
`StartImagePipelineExecution`. The idempotency `clientToken` is generated
automatically. Provide the implementation with
`Effect.provide(AWS.ImageBuilder.CancelImageCreationHttp)`.
### Running Builds
**Example:** Cancel an In-Flight Build
```typescript
// init — account-level binding, no resource argument
const cancelBuild = yield* AWS.ImageBuilder.CancelImageCreation();

// runtime
yield* cancelBuild({ imageBuildVersionArn });
```

@binding

## DeleteImage

Runtime binding for `imagebuilder:DeleteImage`.

Deletes an image build version record (it does NOT deregister the EC2
AMIs or delete the ECR container images the build produced — clean those
up separately). Useful for pruning failed or cancelled builds at runtime.
Account-level binding: pass the build version's ARN. Provide the
implementation with `Effect.provide(AWS.ImageBuilder.DeleteImageHttp)`.
### Running Builds
**Example:** Prune a Cancelled Build
```typescript
// init — account-level binding, no resource argument
const deleteImage = yield* AWS.ImageBuilder.DeleteImage();

// runtime
yield* deleteImage({ imageBuildVersionArn });
```

@binding

## GetImage

Runtime binding for `imagebuilder:GetImage`.

Reads an image build version by ARN — its state (`BUILDING`, `AVAILABLE`,
`CANCELLED`, `FAILED`, …) and the AMIs/containers it produced. Build
versions are created dynamically by pipeline runs, so this is an
account-level binding: pass the `imageBuildVersionArn` returned by
`StartImagePipelineExecution` or found via `ListImagePipelineImages`.
Provide the implementation with
`Effect.provide(AWS.ImageBuilder.GetImageHttp)`.
### Observing Builds
**Example:** Poll a Build's State
```typescript
// init — account-level binding, no resource argument
const getImage = yield* AWS.ImageBuilder.GetImage();

// runtime
const { image } = yield* getImage({ imageBuildVersionArn });
yield* Effect.log(`build is ${image?.state?.status}`);
```

@binding

## GetImagePipeline

Runtime binding for `imagebuilder:GetImagePipeline`.

Reads the bound {@link ImagePipeline}'s current configuration and state —
schedule, status, recipe/infrastructure wiring, and the timestamps of the
latest and next scheduled runs. The pipeline's ARN is injected from the
binding. Provide the implementation with
`Effect.provide(AWS.ImageBuilder.GetImagePipelineHttp)`.
### Observing Pipelines
**Example:** Read the Bound Pipeline's State
```typescript
// init — bind the operation to the pipeline
const getPipeline = yield* AWS.ImageBuilder.GetImagePipeline(pipeline);

// runtime
const { imagePipeline } = yield* getPipeline();
yield* Effect.log(
  `${imagePipeline?.name}: ${imagePipeline?.status}, last run ${imagePipeline?.dateLastRun}`,
);
```

@binding

## GetWorkflowExecution

Runtime binding for `imagebuilder:GetWorkflowExecution`.

Reads the runtime state of one workflow execution (a build/test/distribute
workflow run within an image build) — its status, step counts, and
timing. Workflow executions are created dynamically by builds, so this is
an account-level binding: pass an id from `ListWorkflowExecutions`.
Provide the implementation with
`Effect.provide(AWS.ImageBuilder.GetWorkflowExecutionHttp)`.
### Workflow Monitoring
**Example:** Read a Workflow Execution's State
```typescript
// init — account-level binding, no resource argument
const getWorkflowExecution = yield* AWS.ImageBuilder.GetWorkflowExecution();

// runtime
const execution = yield* getWorkflowExecution({ workflowExecutionId });
yield* Effect.log(`${execution.type} workflow is ${execution.status}`);
```

@binding

## GetWorkflowStepExecution

Runtime binding for `imagebuilder:GetWorkflowStepExecution`.

Reads the runtime state of one workflow step — its action, status,
rollback status, inputs/outputs, and message. Step executions are created
dynamically by builds, so this is an account-level binding: pass an id
from `ListWorkflowStepExecutions` or `ListWaitingWorkflowSteps`. Provide
the implementation with
`Effect.provide(AWS.ImageBuilder.GetWorkflowStepExecutionHttp)`.
### Workflow Monitoring
**Example:** Read a Workflow Step's State
```typescript
// init — account-level binding, no resource argument
const getWorkflowStepExecution =
  yield* AWS.ImageBuilder.GetWorkflowStepExecution();

// runtime
const step = yield* getWorkflowStepExecution({ stepExecutionId });
yield* Effect.log(`step ${step.name} is ${step.status}`);
```

@binding

## ListImageBuildVersions

Runtime binding for `imagebuilder:ListImageBuildVersions`.

Lists the build versions of an image version (`…:image/{name}/{version}`),
newest first — each entry reports its state, so a function can find the
latest `AVAILABLE` build of an image. Image versions are created
dynamically by pipeline runs, so this is an account-level binding.
Provide the implementation with
`Effect.provide(AWS.ImageBuilder.ListImageBuildVersionsHttp)`.
### Observing Builds
**Example:** List the Builds of an Image Version
```typescript
// init — account-level binding, no resource argument
const listImageBuildVersions =
  yield* AWS.ImageBuilder.ListImageBuildVersions();

// runtime
const { imageSummaryList } = yield* listImageBuildVersions({
  imageVersionArn,
});
```

@binding

## ListImagePackages

Runtime binding for `imagebuilder:ListImagePackages`.

Lists the OS packages that Systems Manager Inventory recorded inside an
image at build time (only available once the build is `AVAILABLE`). Build
versions are created dynamically by pipeline runs, so this is an
account-level binding. Provide the implementation with
`Effect.provide(AWS.ImageBuilder.ListImagePackagesHttp)`.
### Observing Builds
**Example:** List the Packages Inside a Built Image
```typescript
// init — account-level binding, no resource argument
const listImagePackages = yield* AWS.ImageBuilder.ListImagePackages();

// runtime
const { imagePackageList } = yield* listImagePackages({
  imageBuildVersionArn,
});
```

@binding

## ListImagePipelineImages

Runtime binding for `imagebuilder:ListImagePipelineImages`.

Enumerates the image build versions the bound {@link ImagePipeline} has
produced — the building block of a "latest AMI from this pipeline" lookup
or a build-history dashboard. The pipeline's ARN is injected from the
binding. Provide the implementation with
`Effect.provide(AWS.ImageBuilder.ListImagePipelineImagesHttp)`.
### Observing Pipelines
**Example:** List the Pipeline's Builds
```typescript
// init — bind the operation to the pipeline
const listBuilds = yield* AWS.ImageBuilder.ListImagePipelineImages(
  pipeline,
);

// runtime
const { imageSummaryList } = yield* listBuilds();
const available = (imageSummaryList ?? []).filter(
  (image) => image.state?.status === "AVAILABLE",
);
```

@binding

## ListImageScanFindingAggregations

Runtime binding for `imagebuilder:ListImageScanFindingAggregations`.

Returns Amazon Inspector finding counts grouped by severity — for the
whole account, or grouped by one key (`imagePipelineArn`,
`imageBuildVersionArn`, `accountId`, `vulnerabilityId`) when a filter is
supplied. Provide the implementation with
`Effect.provide(AWS.ImageBuilder.ListImageScanFindingAggregationsHttp)`.
### Scan Findings
**Example:** Aggregate Findings by Pipeline
```typescript
// init — account-level binding, no resource argument
const listImageScanFindingAggregations =
  yield* AWS.ImageBuilder.ListImageScanFindingAggregations();

// runtime
const { responses } = yield* listImageScanFindingAggregations({
  filter: { name: "imagePipelineArn", values: [pipelineArn] },
});
```

@binding

## ListImageScanFindings

Runtime binding for `imagebuilder:ListImageScanFindings`.

Lists Amazon Inspector scan findings for images in the account (populated
when a pipeline has `imageScanningConfiguration` enabled). Filter by
`imageBuildVersionArn` or `imagePipelineArn` to narrow to one build or
pipeline. Provide the implementation with
`Effect.provide(AWS.ImageBuilder.ListImageScanFindingsHttp)`.
### Scan Findings
**Example:** List Findings for a Pipeline's Builds
```typescript
// init — account-level binding, no resource argument
const listImageScanFindings =
  yield* AWS.ImageBuilder.ListImageScanFindings();

// runtime
const { findings } = yield* listImageScanFindings({
  filters: [{ name: "imagePipelineArn", values: [pipelineArn] }],
});
```

@binding

## ListImages

Runtime binding for `imagebuilder:ListImages`.

Enumerates the image versions you have access to (owned, shared, or
Amazon-managed) — e.g. to discover the latest parent image version.
Newly created images can take up to two minutes to appear. Provide the
implementation with `Effect.provide(AWS.ImageBuilder.ListImagesHttp)`.
### Observing Builds
**Example:** List Your Account's Images
```typescript
// init — account-level binding, no resource argument
const listImages = yield* AWS.ImageBuilder.ListImages();

// runtime
const { imageVersionList } = yield* listImages({ owner: "Self" });
yield* Effect.log(`account has ${imageVersionList?.length ?? 0} images`);
```

@binding

## ListWaitingWorkflowSteps

Runtime binding for `imagebuilder:ListWaitingWorkflowSteps`.

Lists every workflow step in the account that is paused on
`WAIT_FOR_ACTION` — the work queue for an approval function, which then
resumes or stops each build with `SendWorkflowStepAction`. Provide the
implementation with
`Effect.provide(AWS.ImageBuilder.ListWaitingWorkflowStepsHttp)`.
### Workflow Monitoring
**Example:** List Steps Waiting for Action
```typescript
// init — account-level binding, no resource argument
const listWaitingWorkflowSteps =
  yield* AWS.ImageBuilder.ListWaitingWorkflowSteps();

// runtime
const { steps } = yield* listWaitingWorkflowSteps();
```

@binding

## ListWorkflowExecutions

Runtime binding for `imagebuilder:ListWorkflowExecutions`.

Enumerates the build/test/distribution workflow runs of an image build
version — the drill-down view of what a build is currently doing (each
entry reports the workflow's status and step counts). Account-level
binding: pass the `imageBuildVersionArn`. Provide the implementation with
`Effect.provide(AWS.ImageBuilder.ListWorkflowExecutionsHttp)`.
### Observing Builds
**Example:** Inspect a Build's Workflow Progress
```typescript
// init — account-level binding, no resource argument
const listWorkflowExecutions =
  yield* AWS.ImageBuilder.ListWorkflowExecutions();

// runtime
const { workflowExecutions } = yield* listWorkflowExecutions({
  imageBuildVersionArn,
});
for (const execution of workflowExecutions ?? []) {
  yield* Effect.log(`${execution.type}: ${execution.status}`);
}
```

@binding

## ListWorkflowStepExecutions

Runtime binding for `imagebuilder:ListWorkflowStepExecutions`.

Lists the steps of one workflow execution with their runtime status —
drill-down from `ListWorkflowExecutions`. Provide the implementation with
`Effect.provide(AWS.ImageBuilder.ListWorkflowStepExecutionsHttp)`.
### Workflow Monitoring
**Example:** List the Steps of a Workflow Execution
```typescript
// init — account-level binding, no resource argument
const listWorkflowStepExecutions =
  yield* AWS.ImageBuilder.ListWorkflowStepExecutions();

// runtime
const { steps } = yield* listWorkflowStepExecutions({
  workflowExecutionId,
});
```

@binding

## RetryImage

Runtime binding for `imagebuilder:RetryImage`.

Retries a failed image build in place (same build version ARN) — pair it
with `consumeImageEvents` to automatically retry transient build failures.
The idempotency `clientToken` is generated automatically. Provide the
implementation with `Effect.provide(AWS.ImageBuilder.RetryImageHttp)`.
### Running Builds
**Example:** Retry a Failed Build
```typescript
// init — account-level binding, no resource argument
const retryImage = yield* AWS.ImageBuilder.RetryImage();

// runtime
yield* retryImage({ imageBuildVersionArn });
```

@binding

## SendWorkflowStepAction

Runtime binding for `imagebuilder:SendWorkflowStepAction`.

Resumes or stops an image build that is paused on a `WaitForAction`
workflow step — the approval half of a human/automated gate (find pending
steps with `ListWaitingWorkflowSteps`). The idempotency `clientToken` is
generated automatically. Provide the implementation with
`Effect.provide(AWS.ImageBuilder.SendWorkflowStepActionHttp)`.
### Workflow Monitoring
**Example:** Approve a Waiting Build Step
```typescript
// init — account-level binding, no resource argument
const sendWorkflowStepAction =
  yield* AWS.ImageBuilder.SendWorkflowStepAction();

// runtime
yield* sendWorkflowStepAction({
  stepExecutionId,
  imageBuildVersionArn,
  action: "RESUME",
  reason: "approved by review function",
});
```

@binding

## StartImagePipelineExecution

Runtime binding for `imagebuilder:StartImagePipelineExecution`.

Manually kicks off a build of the bound {@link ImagePipeline} — the
pipeline's ARN is injected and the idempotency `clientToken` is generated
automatically. Returns the `imageBuildVersionArn` of the image being
created, for use with `GetImage` / `CancelImageCreation`. Provide the
implementation with
`Effect.provide(AWS.ImageBuilder.StartImagePipelineExecutionHttp)`.
### Running Builds
**Example:** Start a Build of the Bound Pipeline
```typescript
// init — bind the operation to the pipeline
const startBuild = yield* AWS.ImageBuilder.StartImagePipelineExecution(
  pipeline,
);

// runtime
const { imageBuildVersionArn } = yield* startBuild();
yield* Effect.log(`building ${imageBuildVersionArn}`);
```

@binding
