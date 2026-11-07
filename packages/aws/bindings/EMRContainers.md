<!-- Docs for the generated AWS.EMRContainers bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## CancelJobRun

Runtime binding for `emr-containers:CancelJobRun`.

Cancels a job run on the bound {@link VirtualCluster}. The virtual cluster
ID is injected from the binding; pass the job run `id` returned by
`StartJobRun`. Provide the implementation with
`Effect.provide(AWS.EMRContainers.CancelJobRunHttp)`.
### Running Jobs
**Example:** Cancel A Runaway Job
```typescript
// init
const cancelJobRun = yield* AWS.EMRContainers.CancelJobRun(virtualCluster);

// runtime
yield* cancelJobRun({ id: jobRunId });
```

@binding

## DescribeJobRun

Runtime binding for `emr-containers:DescribeJobRun`.

Reads a job run on the bound {@link VirtualCluster} — its state
(`PENDING` → `RUNNING` → `COMPLETED`/`FAILED`/`CANCELLED`), failure
reason, and the resolved driver/configuration. The virtual cluster ID is
injected from the binding; pass the job run `id` returned by
`StartJobRun`. Provide the implementation with
`Effect.provide(AWS.EMRContainers.DescribeJobRunHttp)`.
### Running Jobs
**Example:** Poll A Job Run Until It Finishes
```typescript
// init
const describeJobRun = yield* AWS.EMRContainers.DescribeJobRun(virtualCluster);

// runtime
const { jobRun } = yield* describeJobRun({ id: jobRunId }).pipe(
  Effect.repeat({
    schedule: Schedule.spaced("15 seconds"),
    until: (r) =>
      r.jobRun?.state === "COMPLETED" || r.jobRun?.state === "FAILED",
    times: 40,
  }),
);
```

@binding

## DescribeJobTemplate

Runtime binding for `emr-containers:DescribeJobTemplate`.

Reads the bound {@link JobTemplate}'s stored `StartJobRun` values — the
execution role, release label, job driver, and parameter configuration.
The template ID is injected from the binding. Provide the implementation
with `Effect.provide(AWS.EMRContainers.DescribeJobTemplateHttp)`.
### Job Templates
**Example:** Read The Bound Template
```typescript
// init — bind the operation to the template
const describeJobTemplate =
  yield* AWS.EMRContainers.DescribeJobTemplate(template);

// runtime
const { jobTemplate } = yield* describeJobTemplate();
yield* Effect.log(
  `template targets ${jobTemplate?.jobTemplateData.releaseLabel}`,
);
```

@binding

## DescribeManagedEndpoint

Runtime binding for `emr-containers:DescribeManagedEndpoint`.

Reads a managed endpoint (the EMR Studio gateway) on the bound
{@link VirtualCluster} — its state, server URL, and security group. The
virtual cluster ID is injected from the binding; pass the endpoint `id`.
Provide the implementation with
`Effect.provide(AWS.EMRContainers.DescribeManagedEndpointHttp)`.
### Managed Endpoints
**Example:** Check An Endpoint Is Active
```typescript
// init
const describeManagedEndpoint =
  yield* AWS.EMRContainers.DescribeManagedEndpoint(virtualCluster);

// runtime
const { endpoint } = yield* describeManagedEndpoint({ id: endpointId });
yield* Effect.log(`endpoint state: ${endpoint?.state}`);
```

@binding

## ListJobRuns

Runtime binding for `emr-containers:ListJobRuns`.

Lists job runs on the bound {@link VirtualCluster}, optionally filtered by
state, name, or creation time. The virtual cluster ID is injected from the
binding. Provide the implementation with
`Effect.provide(AWS.EMRContainers.ListJobRunsHttp)`.
### Running Jobs
**Example:** Count Active Job Runs
```typescript
// init
const listJobRuns = yield* AWS.EMRContainers.ListJobRuns(virtualCluster);

// runtime
const { jobRuns } = yield* listJobRuns({
  states: ["PENDING", "SUBMITTED", "RUNNING"],
});
yield* Effect.log(`${jobRuns?.length ?? 0} active job runs`);
```

@binding

## ListJobTemplates

Runtime binding for `emr-containers:ListJobTemplates`.

Enumerates the account's EMR on EKS job templates, optionally filtered by
creation time. Account-level — no resource argument. Provide the
implementation with
`Effect.provide(AWS.EMRContainers.ListJobTemplatesHttp)`.
### Job Templates
**Example:** List All Templates
```typescript
// init — account-level binding, no resource argument
const listJobTemplates = yield* AWS.EMRContainers.ListJobTemplates();

// runtime
const { templates } = yield* listJobTemplates();
yield* Effect.log(`${templates?.length ?? 0} job templates`);
```

@binding

## ListManagedEndpoints

Runtime binding for `emr-containers:ListManagedEndpoints`.

Lists managed endpoints (EMR Studio gateways) on the bound
{@link VirtualCluster}, optionally filtered by state or type. The virtual
cluster ID is injected from the binding. Provide the implementation with
`Effect.provide(AWS.EMRContainers.ListManagedEndpointsHttp)`.
### Managed Endpoints
**Example:** List Active Endpoints
```typescript
// init
const listManagedEndpoints =
  yield* AWS.EMRContainers.ListManagedEndpoints(virtualCluster);

// runtime
const { endpoints } = yield* listManagedEndpoints({ states: ["ACTIVE"] });
```

@binding

## ListVirtualClusters

Runtime binding for `emr-containers:ListVirtualClusters`.

Enumerates the account's EMR on EKS virtual clusters, optionally filtered
by state, container provider, or creation time. Account-level — no
resource argument. Provide the implementation with
`Effect.provide(AWS.EMRContainers.ListVirtualClustersHttp)`.
### Virtual Clusters
**Example:** List Running Virtual Clusters
```typescript
// init — account-level binding, no resource argument
const listVirtualClusters = yield* AWS.EMRContainers.ListVirtualClusters();

// runtime
const { virtualClusters } = yield* listVirtualClusters({
  states: ["RUNNING"],
});
yield* Effect.log(`${virtualClusters?.length ?? 0} running virtual clusters`);
```

@binding
