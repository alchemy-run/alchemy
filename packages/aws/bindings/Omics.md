<!-- Docs for the generated AWS.Omics bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## BatchDeleteReadSet

Runtime binding for `omics:BatchDeleteReadSet`.

Bind this operation to a `SequenceStore` to get a callable that deletes a batch of read sets from the store — the
store/workflow id is injected automatically and the action is granted on the
bound resource. Provide the implementation with
`Effect.provide(AWS.Omics.BatchDeleteReadSetHttp)`.
### Read Sets
**Example:** Bind BatchDeleteReadSet to a SequenceStore
```typescript
// init
const batchDeleteReadSet = yield* AWS.Omics.BatchDeleteReadSet(store);
// runtime
const result = yield* batchDeleteReadSet({});
```

@binding

## CancelRun

Runtime binding for `omics:CancelRun`.

An account-level run-control operation (no resource argument) that cancels an in-progress run.
Provide the implementation with `Effect.provide(AWS.Omics.CancelRunHttp)`.
### Runs
**Example:** Call CancelRun
```typescript
// init — account-level binding takes no resource
const cancelRun = yield* AWS.Omics.CancelRun();
// runtime
const result = yield* cancelRun({ id: runId });
```

@binding

## DeleteReference

Runtime binding for `omics:DeleteReference`.

Bind this operation to a `ReferenceStore` to get a callable that deletes a reference genome from the store — the
store/workflow id is injected automatically and the action is granted on the
bound resource. Provide the implementation with
`Effect.provide(AWS.Omics.DeleteReferenceHttp)`.
### References
**Example:** Bind DeleteReference to a ReferenceStore
```typescript
// init
const deleteReference = yield* AWS.Omics.DeleteReference(store);
// runtime
const result = yield* deleteReference({});
```

@binding

## DeleteRun

Runtime binding for `omics:DeleteRun`.

An account-level run-control operation (no resource argument) that deletes a completed run.
Provide the implementation with `Effect.provide(AWS.Omics.DeleteRunHttp)`.
### Runs
**Example:** Call DeleteRun
```typescript
// init — account-level binding takes no resource
const deleteRun = yield* AWS.Omics.DeleteRun();
// runtime
const result = yield* deleteRun({ id: runId });
```

@binding

## GetReadSet

Runtime binding for `omics:GetReadSet`.

Bind this operation to a `SequenceStore` to get a callable that streams the bytes of a read set file part — the
store/workflow id is injected automatically and the action is granted on the
bound resource. Provide the implementation with
`Effect.provide(AWS.Omics.GetReadSetHttp)`.
### Read Sets
**Example:** Bind GetReadSet to a SequenceStore
```typescript
// init
const getReadSet = yield* AWS.Omics.GetReadSet(store);
// runtime
const result = yield* getReadSet({});
```

@binding

## GetReadSetActivationJob

Runtime binding for `omics:GetReadSetActivationJob`.

Bind this operation to a `SequenceStore` to get a callable that reads the status of a read-set activation job — the
store/workflow id is injected automatically and the action is granted on the
bound resource. Provide the implementation with
`Effect.provide(AWS.Omics.GetReadSetActivationJobHttp)`.
### Read Sets
**Example:** Bind GetReadSetActivationJob to a SequenceStore
```typescript
// init
const getReadSetActivationJob = yield* AWS.Omics.GetReadSetActivationJob(store);
// runtime
const result = yield* getReadSetActivationJob({});
```

@binding

## GetReadSetExportJob

Runtime binding for `omics:GetReadSetExportJob`.

Bind this operation to a `SequenceStore` to get a callable that reads the status of a read-set export job — the
store/workflow id is injected automatically and the action is granted on the
bound resource. Provide the implementation with
`Effect.provide(AWS.Omics.GetReadSetExportJobHttp)`.
### Read Sets
**Example:** Bind GetReadSetExportJob to a SequenceStore
```typescript
// init
const getReadSetExportJob = yield* AWS.Omics.GetReadSetExportJob(store);
// runtime
const result = yield* getReadSetExportJob({});
```

@binding

## GetReadSetImportJob

Runtime binding for `omics:GetReadSetImportJob`.

Bind this operation to a `SequenceStore` to get a callable that reads the status of a read-set import job — the
store/workflow id is injected automatically and the action is granted on the
bound resource. Provide the implementation with
`Effect.provide(AWS.Omics.GetReadSetImportJobHttp)`.
### Read Sets
**Example:** Bind GetReadSetImportJob to a SequenceStore
```typescript
// init
const getReadSetImportJob = yield* AWS.Omics.GetReadSetImportJob(store);
// runtime
const result = yield* getReadSetImportJob({});
```

@binding

## GetReadSetMetadata

Runtime binding for `omics:GetReadSetMetadata`.

Bind this operation to a `SequenceStore` to get a callable that reads the metadata of a read set — the
store/workflow id is injected automatically and the action is granted on the
bound resource. Provide the implementation with
`Effect.provide(AWS.Omics.GetReadSetMetadataHttp)`.
### Read Sets
**Example:** Bind GetReadSetMetadata to a SequenceStore
```typescript
// init
const getReadSetMetadata = yield* AWS.Omics.GetReadSetMetadata(store);
// runtime
const result = yield* getReadSetMetadata({});
```

@binding

## GetReference

Runtime binding for `omics:GetReference`.

Bind this operation to a `ReferenceStore` to get a callable that streams the bytes of a reference file part — the
store/workflow id is injected automatically and the action is granted on the
bound resource. Provide the implementation with
`Effect.provide(AWS.Omics.GetReferenceHttp)`.
### References
**Example:** Bind GetReference to a ReferenceStore
```typescript
// init
const getReference = yield* AWS.Omics.GetReference(store);
// runtime
const result = yield* getReference({});
```

@binding

## GetReferenceImportJob

Runtime binding for `omics:GetReferenceImportJob`.

Bind this operation to a `ReferenceStore` to get a callable that reads the status of a reference import job — the
store/workflow id is injected automatically and the action is granted on the
bound resource. Provide the implementation with
`Effect.provide(AWS.Omics.GetReferenceImportJobHttp)`.
### References
**Example:** Bind GetReferenceImportJob to a ReferenceStore
```typescript
// init
const getReferenceImportJob = yield* AWS.Omics.GetReferenceImportJob(store);
// runtime
const result = yield* getReferenceImportJob({});
```

@binding

## GetReferenceMetadata

Runtime binding for `omics:GetReferenceMetadata`.

Bind this operation to a `ReferenceStore` to get a callable that reads the metadata of a reference genome — the
store/workflow id is injected automatically and the action is granted on the
bound resource. Provide the implementation with
`Effect.provide(AWS.Omics.GetReferenceMetadataHttp)`.
### References
**Example:** Bind GetReferenceMetadata to a ReferenceStore
```typescript
// init
const getReferenceMetadata = yield* AWS.Omics.GetReferenceMetadata(store);
// runtime
const result = yield* getReferenceMetadata({});
```

@binding

## GetRun

Runtime binding for `omics:GetRun`.

An account-level run-control operation (no resource argument) that reads the status and details of a run.
Provide the implementation with `Effect.provide(AWS.Omics.GetRunHttp)`.
### Runs
**Example:** Call GetRun
```typescript
// init — account-level binding takes no resource
const getRun = yield* AWS.Omics.GetRun();
// runtime
const result = yield* getRun({ id: runId });
```

@binding

## GetRunTask

Runtime binding for `omics:GetRunTask`.

An account-level run-control operation (no resource argument) that reads the status of a single task within a run.
Provide the implementation with `Effect.provide(AWS.Omics.GetRunTaskHttp)`.
### Runs
**Example:** Call GetRunTask
```typescript
// init — account-level binding takes no resource
const getRunTask = yield* AWS.Omics.GetRunTask();
// runtime
const result = yield* getRunTask({ id: runId });
```

@binding

## ListAnnotationImportJobs

Runtime binding for `omics:ListAnnotationImportJobs`.

An account-level operation (no resource argument) that lists annotation
import jobs, optionally filtered by store name or status. Provide the
implementation with `Effect.provide(AWS.Omics.ListAnnotationImportJobsHttp)`.
### Annotation Imports
**Example:** Call ListAnnotationImportJobs
```typescript
// init — account-level binding takes no resource
const listImports = yield* AWS.Omics.ListAnnotationImportJobs();
// runtime
const result = yield* listImports({});
```

@binding

## ListReadSetActivationJobs

Runtime binding for `omics:ListReadSetActivationJobs`.

Bind this operation to a `SequenceStore` to get a callable that lists the read-set activation jobs for the store — the
store/workflow id is injected automatically and the action is granted on the
bound resource. Provide the implementation with
`Effect.provide(AWS.Omics.ListReadSetActivationJobsHttp)`.
### Read Sets
**Example:** Bind ListReadSetActivationJobs to a SequenceStore
```typescript
// init
const listReadSetActivationJobs = yield* AWS.Omics.ListReadSetActivationJobs(store);
// runtime
const result = yield* listReadSetActivationJobs({});
```

@binding

## ListReadSetExportJobs

Runtime binding for `omics:ListReadSetExportJobs`.

Bind this operation to a `SequenceStore` to get a callable that lists the read-set export jobs for the store — the
store/workflow id is injected automatically and the action is granted on the
bound resource. Provide the implementation with
`Effect.provide(AWS.Omics.ListReadSetExportJobsHttp)`.
### Read Sets
**Example:** Bind ListReadSetExportJobs to a SequenceStore
```typescript
// init
const listReadSetExportJobs = yield* AWS.Omics.ListReadSetExportJobs(store);
// runtime
const result = yield* listReadSetExportJobs({});
```

@binding

## ListReadSetImportJobs

Runtime binding for `omics:ListReadSetImportJobs`.

Bind this operation to a `SequenceStore` to get a callable that lists the read-set import jobs for the store — the
store/workflow id is injected automatically and the action is granted on the
bound resource. Provide the implementation with
`Effect.provide(AWS.Omics.ListReadSetImportJobsHttp)`.
### Read Sets
**Example:** Bind ListReadSetImportJobs to a SequenceStore
```typescript
// init
const listReadSetImportJobs = yield* AWS.Omics.ListReadSetImportJobs(store);
// runtime
const result = yield* listReadSetImportJobs({});
```

@binding

## ListReadSets

Runtime binding for `omics:ListReadSets`.

Bind this operation to a `SequenceStore` to get a callable that lists the read sets in the store — the
store/workflow id is injected automatically and the action is granted on the
bound resource. Provide the implementation with
`Effect.provide(AWS.Omics.ListReadSetsHttp)`.
### Read Sets
**Example:** Bind ListReadSets to a SequenceStore
```typescript
// init
const listReadSets = yield* AWS.Omics.ListReadSets(store);
// runtime
const result = yield* listReadSets({});
```

@binding

## ListReferenceImportJobs

Runtime binding for `omics:ListReferenceImportJobs`.

Bind this operation to a `ReferenceStore` to get a callable that lists the reference import jobs for the store — the
store/workflow id is injected automatically and the action is granted on the
bound resource. Provide the implementation with
`Effect.provide(AWS.Omics.ListReferenceImportJobsHttp)`.
### References
**Example:** Bind ListReferenceImportJobs to a ReferenceStore
```typescript
// init
const listReferenceImportJobs = yield* AWS.Omics.ListReferenceImportJobs(store);
// runtime
const result = yield* listReferenceImportJobs({});
```

@binding

## ListReferences

Runtime binding for `omics:ListReferences`.

Bind this operation to a `ReferenceStore` to get a callable that lists the reference genomes in the store — the
store/workflow id is injected automatically and the action is granted on the
bound resource. Provide the implementation with
`Effect.provide(AWS.Omics.ListReferencesHttp)`.
### References
**Example:** Bind ListReferences to a ReferenceStore
```typescript
// init
const listReferences = yield* AWS.Omics.ListReferences(store);
// runtime
const result = yield* listReferences({});
```

@binding

## ListRunTasks

Runtime binding for `omics:ListRunTasks`.

An account-level run-control operation (no resource argument) that lists the tasks within a run.
Provide the implementation with `Effect.provide(AWS.Omics.ListRunTasksHttp)`.
### Runs
**Example:** Call ListRunTasks
```typescript
// init — account-level binding takes no resource
const listRunTasks = yield* AWS.Omics.ListRunTasks();
// runtime
const result = yield* listRunTasks({ id: runId });
```

@binding

## ListRuns

Runtime binding for `omics:ListRuns`.

An account-level run-control operation (no resource argument) that lists the workflow runs in the account.
Provide the implementation with `Effect.provide(AWS.Omics.ListRunsHttp)`.
### Runs
**Example:** Call ListRuns
```typescript
// init — account-level binding takes no resource
const listRuns = yield* AWS.Omics.ListRuns();
// runtime
const result = yield* listRuns({ id: runId });
```

@binding

## ListVariantImportJobs

Runtime binding for `omics:ListVariantImportJobs`.

An account-level operation (no resource argument) that lists variant import
jobs, optionally filtered by store name or status. Provide the
implementation with `Effect.provide(AWS.Omics.ListVariantImportJobsHttp)`.
### Variant Imports
**Example:** Call ListVariantImportJobs
```typescript
// init — account-level binding takes no resource
const listImports = yield* AWS.Omics.ListVariantImportJobs();
// runtime
const result = yield* listImports({});
```

@binding

## StartAnnotationImportJob

Runtime binding for `omics:StartAnnotationImportJob`.

Bind this operation to an `AnnotationStore` to get a callable that starts a
job importing annotation files (TSV/VCF/GFF) into the store — the store name
is injected automatically as `destinationName` and the action is granted on
the bound resource (with `iam:PassRole` for the HealthOmics service role).
Provide the implementation with
`Effect.provide(AWS.Omics.StartAnnotationImportJobHttp)`.
### Annotation Imports
**Example:** Bind StartAnnotationImportJob to an AnnotationStore
```typescript
// init
const startImport = yield* AWS.Omics.StartAnnotationImportJob(store);
// runtime
const result = yield* startImport({
  roleArn,
  items: [{ source: "s3://my-bucket/annotations.tsv" }],
});
```

@binding

## StartReadSetActivationJob

Runtime binding for `omics:StartReadSetActivationJob`.

Bind this operation to a `SequenceStore` to get a callable that starts a job that activates archived read sets — the
store/workflow id is injected automatically and the action is granted on the
bound resource. Provide the implementation with
`Effect.provide(AWS.Omics.StartReadSetActivationJobHttp)`.
### Read Sets
**Example:** Bind StartReadSetActivationJob to a SequenceStore
```typescript
// init
const startReadSetActivationJob = yield* AWS.Omics.StartReadSetActivationJob(store);
// runtime
const result = yield* startReadSetActivationJob({});
```

@binding

## StartReadSetExportJob

Runtime binding for `omics:StartReadSetExportJob`.

Bind this operation to a `SequenceStore` to get a callable that starts a job that exports read sets to S3 — the
store/workflow id is injected automatically and the action is granted on the
bound resource. Provide the implementation with
`Effect.provide(AWS.Omics.StartReadSetExportJobHttp)`.
### Read Sets
**Example:** Bind StartReadSetExportJob to a SequenceStore
```typescript
// init
const startReadSetExportJob = yield* AWS.Omics.StartReadSetExportJob(store);
// runtime
const result = yield* startReadSetExportJob({});
```

@binding

## StartReadSetImportJob

Runtime binding for `omics:StartReadSetImportJob`.

Bind this operation to a `SequenceStore` to get a callable that starts an import job that ingests read sets into the store — the
store/workflow id is injected automatically and the action is granted on the
bound resource. Provide the implementation with
`Effect.provide(AWS.Omics.StartReadSetImportJobHttp)`.
### Read Sets
**Example:** Bind StartReadSetImportJob to a SequenceStore
```typescript
// init
const startReadSetImportJob = yield* AWS.Omics.StartReadSetImportJob(store);
// runtime
const result = yield* startReadSetImportJob({});
```

@binding

## StartReferenceImportJob

Runtime binding for `omics:StartReferenceImportJob`.

Bind this operation to a `ReferenceStore` to get a callable that starts a job that imports reference genomes into the store — the
store/workflow id is injected automatically and the action is granted on the
bound resource. Provide the implementation with
`Effect.provide(AWS.Omics.StartReferenceImportJobHttp)`.
### References
**Example:** Bind StartReferenceImportJob to a ReferenceStore
```typescript
// init
const startReferenceImportJob = yield* AWS.Omics.StartReferenceImportJob(store);
// runtime
const result = yield* startReferenceImportJob({});
```

@binding

## StartRun

Runtime binding for `omics:StartRun`.

Bind this operation to a `Workflow` to get a callable that starts a run of the bound workflow — the
store/workflow id is injected automatically and the action is granted on the
bound resource. Provide the implementation with
`Effect.provide(AWS.Omics.StartRunHttp)`.
### Runs
**Example:** Bind StartRun to a Workflow
```typescript
// init
const startRun = yield* AWS.Omics.StartRun(workflow);
// runtime
const result = yield* startRun({});
```

@binding

## StartVariantImportJob

Runtime binding for `omics:StartVariantImportJob`.

Bind this operation to a `VariantStore` to get a callable that starts a job
importing VCF variant files into the store — the store name is injected
automatically as `destinationName` and the action is granted on the bound
resource (with `iam:PassRole` for the HealthOmics service role). Provide the
implementation with `Effect.provide(AWS.Omics.StartVariantImportJobHttp)`.
### Variant Imports
**Example:** Bind StartVariantImportJob to a VariantStore
```typescript
// init
const startImport = yield* AWS.Omics.StartVariantImportJob(store);
// runtime
const result = yield* startImport({
  roleArn,
  items: [{ source: "s3://my-bucket/variants.vcf" }],
});
```

@binding
