<!-- Docs for the generated AWS.HealthLake bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## DescribeFHIRExportJob

Runtime binding for the `DescribeFHIRExportJob` operation (IAM action
`healthlake:DescribeFHIRExportJob`), scoped to one {@link FHIRDatastore}.

Reads the properties of a bulk FHIR export job started with
{@link StartFHIRExportJob} — poll `ExportJobProperties.JobStatus` until
`COMPLETED` (or a failure status). Provide the implementation with
`Effect.provide(AWS.HealthLake.DescribeFHIRExportJobHttp)`.

### Exporting FHIR Data
**Example:** Poll an Export Job Until It Completes
```typescript
const describeExport = yield* HealthLake.DescribeFHIRExportJob(datastore);

const job = yield* describeExport({ JobId: jobId }).pipe(
  Effect.map((r) => r.ExportJobProperties),
  Effect.repeat({
    schedule: Schedule.spaced("10 seconds"),
    until: (j) => j.JobStatus !== "SUBMITTED" && j.JobStatus !== "IN_PROGRESS",
    times: 30,
  }),
);
```

@binding

## DescribeFHIRExportJob.Request

`DescribeFHIRExportJob` request with `DatastoreId` injected from the bound
data store.

## DescribeFHIRImportJob

Runtime binding for the `DescribeFHIRImportJob` operation (IAM action
`healthlake:DescribeFHIRImportJob`), scoped to one {@link FHIRDatastore}.

Reads the properties and progress report of a bulk FHIR import job started
with {@link StartFHIRImportJob} — poll `ImportJobProperties.JobStatus`
until `COMPLETED` (or a failure status). Provide the implementation with
`Effect.provide(AWS.HealthLake.DescribeFHIRImportJobHttp)`.

### Importing FHIR Data
**Example:** Poll an Import Job Until It Completes
```typescript
const describeImport = yield* HealthLake.DescribeFHIRImportJob(datastore);

const job = yield* describeImport({ JobId: jobId }).pipe(
  Effect.map((r) => r.ImportJobProperties),
  Effect.repeat({
    schedule: Schedule.spaced("10 seconds"),
    until: (j) => j.JobStatus !== "SUBMITTED" && j.JobStatus !== "IN_PROGRESS",
    times: 30,
  }),
);
```

@binding

## DescribeFHIRImportJob.Request

`DescribeFHIRImportJob` request with `DatastoreId` injected from the bound
data store.

## ListFHIRExportJobs

Runtime binding for the `ListFHIRExportJobs` operation (IAM action
`healthlake:ListFHIRExportJobs`), scoped to one {@link FHIRDatastore}.

Lists the bulk FHIR export jobs of the bound data store, optionally
filtered by name, status or submit-time window. Provide the implementation
with `Effect.provide(AWS.HealthLake.ListFHIRExportJobsHttp)`.

### Exporting FHIR Data
**Example:** List Recent Export Jobs
```typescript
const listExports = yield* HealthLake.ListFHIRExportJobs(datastore);

const jobs = yield* listExports({ JobStatus: "IN_PROGRESS" });
// jobs.ExportJobPropertiesList, jobs.NextToken
```

@binding

## ListFHIRExportJobs.Request

`ListFHIRExportJobs` request with `DatastoreId` injected from the bound
data store.

## ListFHIRImportJobs

Runtime binding for the `ListFHIRImportJobs` operation (IAM action
`healthlake:ListFHIRImportJobs`), scoped to one {@link FHIRDatastore}.

Lists the bulk FHIR import jobs of the bound data store, optionally
filtered by name, status or submit-time window. Provide the implementation
with `Effect.provide(AWS.HealthLake.ListFHIRImportJobsHttp)`.

### Importing FHIR Data
**Example:** List Recent Import Jobs
```typescript
const listImports = yield* HealthLake.ListFHIRImportJobs(datastore);

const jobs = yield* listImports({ JobStatus: "COMPLETED" });
// jobs.ImportJobPropertiesList, jobs.NextToken
```

@binding

## ListFHIRImportJobs.Request

`ListFHIRImportJobs` request with `DatastoreId` injected from the bound
data store.
