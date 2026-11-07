<!-- Docs for the generated AWS.OSIS bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## GetPipeline

Runtime binding for `osis:GetPipeline`.

Reads the bound {@link Pipeline}'s live detail — status, capacity, ingest
endpoint URLs, and destinations — so an ops function can health-check the
pipeline or discover its ingest endpoints at runtime. The pipeline name is
injected from the binding. Provide the implementation with
`Effect.provide(AWS.OSIS.GetPipelineHttp)`.
### Monitoring a Pipeline
**Example:** Check the Pipeline's Status
```typescript
// init — bind the operation to the pipeline
const getPipeline = yield* AWS.OSIS.GetPipeline(pipeline);

// runtime
const { Pipeline } = yield* getPipeline();
if (Pipeline?.Status !== "ACTIVE") {
  yield* Effect.logWarning(`pipeline is ${Pipeline?.Status}`);
}
```

@binding

## GetPipelineBlueprint

Runtime binding for `osis:GetPipelineBlueprint`.

Retrieves one Data Prepper blueprint's full configuration template so
config-authoring tooling can render or specialize it (pair with
{@link ListPipelineBlueprints} to discover blueprint names). Account-level:
no resource argument. Provide the implementation with
`Effect.provide(AWS.OSIS.GetPipelineBlueprintHttp)`.
### Authoring Pipeline Configurations
**Example:** Fetch a Blueprint's Template
```typescript
// init — account-level binding, no resource argument
const getPipelineBlueprint = yield* AWS.OSIS.GetPipelineBlueprint();

// runtime
const { Blueprint } = yield* getPipelineBlueprint({
  BlueprintName: "AWS-ApacheLogPipeline",
});
// Blueprint?.PipelineConfigurationBody — the YAML template
```

@binding

## GetPipelineChangeProgress

Runtime binding for `osis:GetPipelineChangeProgress`.

Reads progress information for the current change happening on the bound
{@link Pipeline} (stage-by-stage status while the pipeline is being
created) — useful for surfacing provisioning progress in an operational
dashboard. The pipeline name is injected from the binding. Provide the
implementation with `Effect.provide(AWS.OSIS.GetPipelineChangeProgressHttp)`.
### Monitoring a Pipeline
**Example:** Report Creation Progress
```typescript
// init — bind the operation to the pipeline
const getChangeProgress = yield* AWS.OSIS.GetPipelineChangeProgress(pipeline);

// runtime
const { ChangeProgressStatuses } = yield* getChangeProgress();
for (const status of ChangeProgressStatuses ?? []) {
  yield* Effect.log(`${status.Status}: ${status.ChangeProgressStages?.length} stages`);
}
```

@binding

## ListPipelineBlueprints

Runtime binding for `osis:ListPipelineBlueprints`.

Lists the available Data Prepper blueprints — AWS-provided configuration
templates for common source/sink topologies — so config-authoring tooling
can offer them as starting points. Account-level: no resource argument.
Provide the implementation with
`Effect.provide(AWS.OSIS.ListPipelineBlueprintsHttp)`.
### Authoring Pipeline Configurations
**Example:** List Available Blueprints
```typescript
// init — account-level binding, no resource argument
const listPipelineBlueprints = yield* AWS.OSIS.ListPipelineBlueprints();

// runtime
const { Blueprints } = yield* listPipelineBlueprints();
// [{ BlueprintName: "AWS-CloudTrailLogsToOpenSearch", ... }, ...]
```

@binding

## ListPipelineEndpointConnections

Runtime binding for `osis:ListPipelineEndpointConnections`.

Lists the VPC endpoint connections attached to pipelines in the account —
including endpoints owned by other accounts — so an ops function can audit
who can ingest into your pipelines (pair with
{@link RevokePipelineEndpointConnections} to cut off access). Account-level:
no resource argument. Provide the implementation with
`Effect.provide(AWS.OSIS.ListPipelineEndpointConnectionsHttp)`.
### Managing Endpoint Connections
**Example:** Audit Endpoint Connections
```typescript
// init — account-level binding, no resource argument
const listConnections = yield* AWS.OSIS.ListPipelineEndpointConnections();

// runtime
const { PipelineEndpointConnections } = yield* listConnections();
for (const connection of PipelineEndpointConnections ?? []) {
  yield* Effect.log(
    `${connection.EndpointId} (owner ${connection.VpcEndpointOwner})`,
  );
}
```

@binding

## RevokePipelineEndpointConnections

Runtime binding for `osis:RevokePipelineEndpointConnections`.

Revokes VPC endpoint connections attached to the bound {@link Pipeline} —
a security control that cuts off ingest access from specific endpoints
(e.g. after an account is offboarded). The pipeline ARN is injected from
the binding; pass the endpoint IDs to revoke. Provide the implementation
with `Effect.provide(AWS.OSIS.RevokePipelineEndpointConnectionsHttp)`.
### Managing Endpoint Connections
**Example:** Revoke an Endpoint's Access
```typescript
// init — bind the operation to the pipeline
const revokeConnections =
  yield* AWS.OSIS.RevokePipelineEndpointConnections(pipeline);

// runtime
yield* revokeConnections({ EndpointIds: ["pe-1234567890abcdef0"] });
```

@binding

## StartPipeline

Runtime binding for `osis:StartPipeline`.

Starts the bound {@link Pipeline} after it was stopped — e.g. resuming
ingestion on a schedule or in response to an operational signal. Starting
takes several minutes; the response reports the transitional `STARTING`
status. The pipeline name is injected from the binding. Provide the
implementation with `Effect.provide(AWS.OSIS.StartPipelineHttp)`.
### Controlling a Pipeline
**Example:** Resume Ingestion
```typescript
// init — bind the operation to the pipeline
const startPipeline = yield* AWS.OSIS.StartPipeline(pipeline);

// runtime
const { Pipeline } = yield* startPipeline();
// Pipeline?.Status === "STARTING"
```

@binding

## StopPipeline

Runtime binding for `osis:StopPipeline`.

Stops the bound {@link Pipeline} — ingestion halts and OCU billing stops
(persistent-buffer storage is retained) — e.g. pausing a non-production
pipeline outside working hours. The pipeline name is injected from the
binding. Provide the implementation with
`Effect.provide(AWS.OSIS.StopPipelineHttp)`.
### Controlling a Pipeline
**Example:** Pause Ingestion
```typescript
// init — bind the operation to the pipeline
const stopPipeline = yield* AWS.OSIS.StopPipeline(pipeline);

// runtime
const { Pipeline } = yield* stopPipeline();
// Pipeline?.Status === "STOPPING"
```

@binding

## ValidatePipeline

Runtime binding for `osis:ValidatePipeline`.

Checks whether a Data Prepper pipeline configuration body is valid prior to
creation — the building block of config-authoring tooling (validate a
generated configuration before calling `CreatePipeline`, or lint
user-submitted configs in a self-service portal). Account-level: no
resource argument. Provide the implementation with
`Effect.provide(AWS.OSIS.ValidatePipelineHttp)`.
### Authoring Pipeline Configurations
**Example:** Validate a Configuration Body
```typescript
// init — account-level binding, no resource argument
const validatePipeline = yield* AWS.OSIS.ValidatePipeline();

// runtime
const { isValid, Errors } = yield* validatePipeline({
  PipelineConfigurationBody: configYaml,
});
if (!isValid) {
  yield* Effect.logError(Errors?.map((e) => e.Message).join("\n") ?? "");
}
```

@binding
