<!-- Docs for the generated AWS.ComprehendMedical bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## DescribeEntitiesDetectionV2Job

Runtime binding for `comprehendmedical:DescribeEntitiesDetectionV2Job` — get the properties and status of an asynchronous medical entity detection job.

Comprehend Medical has no resource-level IAM, so the binding takes no
arguments and grants `comprehendmedical:DescribeEntitiesDetectionV2Job` on `*`. Provide the
implementation with `Effect.provide(AWS.ComprehendMedical.DescribeEntitiesDetectionV2JobHttp)`.

### Batch Entity Detection Jobs
**Example:** Poll a Job's Status
```typescript
// init
const describeEntitiesDetectionV2Job = yield* AWS.ComprehendMedical.DescribeEntitiesDetectionV2Job();

// runtime
const status = yield* describeEntitiesDetectionV2Job({ JobId: jobId });
console.log(status.ComprehendMedicalAsyncJobProperties?.JobStatus);
```

@binding

## DescribeICD10CMInferenceJob

Runtime binding for `comprehendmedical:DescribeICD10CMInferenceJob` — get the properties and status of an asynchronous ICD-10-CM ontology linking job.

Comprehend Medical has no resource-level IAM, so the binding takes no
arguments and grants `comprehendmedical:DescribeICD10CMInferenceJob` on `*`. Provide the
implementation with `Effect.provide(AWS.ComprehendMedical.DescribeICD10CMInferenceJobHttp)`.

### Batch ICD-10-CM Inference Jobs
**Example:** Poll a Job's Status
```typescript
// init
const describeICD10CMInferenceJob = yield* AWS.ComprehendMedical.DescribeICD10CMInferenceJob();

// runtime
const status = yield* describeICD10CMInferenceJob({ JobId: jobId });
console.log(status.ComprehendMedicalAsyncJobProperties?.JobStatus);
```

@binding

## DescribePHIDetectionJob

Runtime binding for `comprehendmedical:DescribePHIDetectionJob` — get the properties and status of an asynchronous protected health information (PHI) detection job.

Comprehend Medical has no resource-level IAM, so the binding takes no
arguments and grants `comprehendmedical:DescribePHIDetectionJob` on `*`. Provide the
implementation with `Effect.provide(AWS.ComprehendMedical.DescribePHIDetectionJobHttp)`.

### Batch PHI Detection Jobs
**Example:** Poll a Job's Status
```typescript
// init
const describePHIDetectionJob = yield* AWS.ComprehendMedical.DescribePHIDetectionJob();

// runtime
const status = yield* describePHIDetectionJob({ JobId: jobId });
console.log(status.ComprehendMedicalAsyncJobProperties?.JobStatus);
```

@binding

## DescribeRxNormInferenceJob

Runtime binding for `comprehendmedical:DescribeRxNormInferenceJob` — get the properties and status of an asynchronous RxNorm ontology linking job.

Comprehend Medical has no resource-level IAM, so the binding takes no
arguments and grants `comprehendmedical:DescribeRxNormInferenceJob` on `*`. Provide the
implementation with `Effect.provide(AWS.ComprehendMedical.DescribeRxNormInferenceJobHttp)`.

### Batch RxNorm Inference Jobs
**Example:** Poll a Job's Status
```typescript
// init
const describeRxNormInferenceJob = yield* AWS.ComprehendMedical.DescribeRxNormInferenceJob();

// runtime
const status = yield* describeRxNormInferenceJob({ JobId: jobId });
console.log(status.ComprehendMedicalAsyncJobProperties?.JobStatus);
```

@binding

## DescribeSNOMEDCTInferenceJob

Runtime binding for `comprehendmedical:DescribeSNOMEDCTInferenceJob` — get the properties and status of an asynchronous SNOMED CT ontology linking job.

Comprehend Medical has no resource-level IAM, so the binding takes no
arguments and grants `comprehendmedical:DescribeSNOMEDCTInferenceJob` on `*`. Provide the
implementation with `Effect.provide(AWS.ComprehendMedical.DescribeSNOMEDCTInferenceJobHttp)`.

### Batch SNOMED CT Inference Jobs
**Example:** Poll a Job's Status
```typescript
// init
const describeSNOMEDCTInferenceJob = yield* AWS.ComprehendMedical.DescribeSNOMEDCTInferenceJob();

// runtime
const status = yield* describeSNOMEDCTInferenceJob({ JobId: jobId });
console.log(status.ComprehendMedicalAsyncJobProperties?.JobStatus);
```

@binding

## DetectEntitiesV2

Runtime binding for `comprehendmedical:DetectEntitiesV2` — extract medical
entities (medications, medical conditions, anatomy, PHI, tests/treatments)
and their attributes and traits from clinical text.

Comprehend Medical is a pure pay-per-call service with no resource to
manage: the binding takes no arguments and grants the function
`comprehendmedical:DetectEntitiesV2` (the action has no resource-level
IAM). Pass the clinical note as raw text — no marshalling.

### Detecting Medical Entities
**Example:** Detect Entities in a Clinical Note
```typescript
// init
const detectEntities = yield* AWS.ComprehendMedical.DetectEntitiesV2();

// runtime
const result = yield* detectEntities({
  Text: "Patient takes 50 mg atenolol daily for hypertension.",
});
const names = (result.Entities ?? []).map((entity) => entity.Text);
```

@binding

## DetectPHI

Runtime binding for `comprehendmedical:DetectPHI` — detect protected health
information (PHI) entities (name, address, age, ID numbers, dates…) in
clinical text.

Comprehend Medical is a pure pay-per-call service with no resource to
manage: the binding takes no arguments and grants the function
`comprehendmedical:DetectPHI` (the action has no resource-level IAM). Pass
the clinical note as raw text — no marshalling.

### Detecting PHI
**Example:** Detect PHI in a Clinical Note
```typescript
// init
const detectPHI = yield* AWS.ComprehendMedical.DetectPHI();

// runtime
const result = yield* detectPHI({
  Text: "John Doe, age 47, was seen on 2024-01-03.",
});
const phi = (result.Entities ?? []).map((entity) => entity.Type);
```

@binding

## InferICD10CM

Runtime binding for `comprehendmedical:InferICD10CM` — detect medical
conditions in clinical text and link them to ICD-10-CM ontology codes with
confidence scores.

Comprehend Medical is a pure pay-per-call service with no resource to
manage: the binding takes no arguments and grants the function
`comprehendmedical:InferICD10CM` (the action has no resource-level IAM).
Pass the clinical note as raw text — no marshalling.

### Inferring ICD-10-CM Codes
**Example:** Infer ICD-10-CM Codes from a Clinical Note
```typescript
// init
const inferICD10CM = yield* AWS.ComprehendMedical.InferICD10CM();

// runtime
const result = yield* inferICD10CM({
  Text: "Patient presents with type 2 diabetes and hypertension.",
});
const codes = (result.Entities ?? []).flatMap((entity) =>
  (entity.ICD10CMConcepts ?? []).map((concept) => concept.Code),
);
```

@binding

## InferRxNorm

Runtime binding for `comprehendmedical:InferRxNorm` — detect medication entities in clinical text and link them to concept identifiers in the RxNorm ontology (medication names, dosages, frequencies).

Comprehend Medical has no resource-level IAM, so the binding takes no
arguments and grants `comprehendmedical:InferRxNorm` on `*`. Provide the
implementation with `Effect.provide(AWS.ComprehendMedical.InferRxNormHttp)`.

### Linking Medications to RxNorm
**Example:** Infer RxNorm Concepts for a Medication List
```typescript
// init
const inferRxNorm = yield* AWS.ComprehendMedical.InferRxNorm();

// runtime
const result = yield* inferRxNorm({
  Text: "Patient takes 50 mg atenolol daily.",
});
const concepts = (result.Entities ?? []).flatMap((e) => e.RxNormConcepts ?? []);
```

@binding

## InferSNOMEDCT

Runtime binding for `comprehendmedical:InferSNOMEDCT` — detect medical concepts in clinical text and link them to codes in the Systematized Nomenclature of Medicine, Clinical Terms (SNOMED CT) ontology.

Comprehend Medical has no resource-level IAM, so the binding takes no
arguments and grants `comprehendmedical:InferSNOMEDCT` on `*`. Provide the
implementation with `Effect.provide(AWS.ComprehendMedical.InferSNOMEDCTHttp)`.

### Linking Concepts to SNOMED CT
**Example:** Infer SNOMED CT Concepts for a Clinical Note
```typescript
// init
const inferSNOMEDCT = yield* AWS.ComprehendMedical.InferSNOMEDCT();

// runtime
const result = yield* inferSNOMEDCT({
  Text: "Patient presents with type 2 diabetes.",
});
const concepts = (result.Entities ?? []).flatMap((e) => e.SNOMEDCTConcepts ?? []);
```

@binding

## ListEntitiesDetectionV2Jobs

Runtime binding for `comprehendmedical:ListEntitiesDetectionV2Jobs` — list the asynchronous medical entity detection jobs you have submitted.

Comprehend Medical has no resource-level IAM, so the binding takes no
arguments and grants `comprehendmedical:ListEntitiesDetectionV2Jobs` on `*`. Provide the
implementation with `Effect.provide(AWS.ComprehendMedical.ListEntitiesDetectionV2JobsHttp)`.

### Batch Entity Detection Jobs
**Example:** List Submitted Jobs
```typescript
// init
const listEntitiesDetectionV2Jobs = yield* AWS.ComprehendMedical.ListEntitiesDetectionV2Jobs();

// runtime
const jobs = yield* listEntitiesDetectionV2Jobs({});
console.log(jobs.ComprehendMedicalAsyncJobPropertiesList?.length ?? 0);
```

@binding

## ListICD10CMInferenceJobs

Runtime binding for `comprehendmedical:ListICD10CMInferenceJobs` — list the asynchronous ICD-10-CM ontology linking jobs you have submitted.

Comprehend Medical has no resource-level IAM, so the binding takes no
arguments and grants `comprehendmedical:ListICD10CMInferenceJobs` on `*`. Provide the
implementation with `Effect.provide(AWS.ComprehendMedical.ListICD10CMInferenceJobsHttp)`.

### Batch ICD-10-CM Inference Jobs
**Example:** List Submitted Jobs
```typescript
// init
const listICD10CMInferenceJobs = yield* AWS.ComprehendMedical.ListICD10CMInferenceJobs();

// runtime
const jobs = yield* listICD10CMInferenceJobs({});
console.log(jobs.ComprehendMedicalAsyncJobPropertiesList?.length ?? 0);
```

@binding

## ListPHIDetectionJobs

Runtime binding for `comprehendmedical:ListPHIDetectionJobs` — list the asynchronous protected health information (PHI) detection jobs you have submitted.

Comprehend Medical has no resource-level IAM, so the binding takes no
arguments and grants `comprehendmedical:ListPHIDetectionJobs` on `*`. Provide the
implementation with `Effect.provide(AWS.ComprehendMedical.ListPHIDetectionJobsHttp)`.

### Batch PHI Detection Jobs
**Example:** List Submitted Jobs
```typescript
// init
const listPHIDetectionJobs = yield* AWS.ComprehendMedical.ListPHIDetectionJobs();

// runtime
const jobs = yield* listPHIDetectionJobs({});
console.log(jobs.ComprehendMedicalAsyncJobPropertiesList?.length ?? 0);
```

@binding

## ListRxNormInferenceJobs

Runtime binding for `comprehendmedical:ListRxNormInferenceJobs` — list the asynchronous RxNorm ontology linking jobs you have submitted.

Comprehend Medical has no resource-level IAM, so the binding takes no
arguments and grants `comprehendmedical:ListRxNormInferenceJobs` on `*`. Provide the
implementation with `Effect.provide(AWS.ComprehendMedical.ListRxNormInferenceJobsHttp)`.

### Batch RxNorm Inference Jobs
**Example:** List Submitted Jobs
```typescript
// init
const listRxNormInferenceJobs = yield* AWS.ComprehendMedical.ListRxNormInferenceJobs();

// runtime
const jobs = yield* listRxNormInferenceJobs({});
console.log(jobs.ComprehendMedicalAsyncJobPropertiesList?.length ?? 0);
```

@binding

## ListSNOMEDCTInferenceJobs

Runtime binding for `comprehendmedical:ListSNOMEDCTInferenceJobs` — list the asynchronous SNOMED CT ontology linking jobs you have submitted.

Comprehend Medical has no resource-level IAM, so the binding takes no
arguments and grants `comprehendmedical:ListSNOMEDCTInferenceJobs` on `*`. Provide the
implementation with `Effect.provide(AWS.ComprehendMedical.ListSNOMEDCTInferenceJobsHttp)`.

### Batch SNOMED CT Inference Jobs
**Example:** List Submitted Jobs
```typescript
// init
const listSNOMEDCTInferenceJobs = yield* AWS.ComprehendMedical.ListSNOMEDCTInferenceJobs();

// runtime
const jobs = yield* listSNOMEDCTInferenceJobs({});
console.log(jobs.ComprehendMedicalAsyncJobPropertiesList?.length ?? 0);
```

@binding

## StartEntitiesDetectionV2Job

Runtime binding for `comprehendmedical:StartEntitiesDetectionV2Job` — start an asynchronous medical entity detection job over a collection of documents in S3. Also grants `iam:PassRole` (conditioned to `comprehendmedical.amazonaws.com`) for the job's data-access role.

Comprehend Medical has no resource-level IAM, so the binding takes no
arguments and grants `comprehendmedical:StartEntitiesDetectionV2Job` on `*`. Provide the
implementation with `Effect.provide(AWS.ComprehendMedical.StartEntitiesDetectionV2JobHttp)`.

### Batch Entity Detection Jobs
**Example:** Start a Batch Job
```typescript
// init
const startEntitiesDetectionV2Job = yield* AWS.ComprehendMedical.StartEntitiesDetectionV2Job();

// runtime
const job = yield* startEntitiesDetectionV2Job({
  InputDataConfig: { S3Bucket: "my-input-bucket", S3Key: "notes/" },
  OutputDataConfig: { S3Bucket: "my-output-bucket" },
  DataAccessRoleArn: dataAccessRole.roleArn,
  LanguageCode: "en",
});
```

@binding

## StartICD10CMInferenceJob

Runtime binding for `comprehendmedical:StartICD10CMInferenceJob` — start an asynchronous ICD-10-CM ontology linking job over a collection of documents in S3. Also grants `iam:PassRole` (conditioned to `comprehendmedical.amazonaws.com`) for the job's data-access role.

Comprehend Medical has no resource-level IAM, so the binding takes no
arguments and grants `comprehendmedical:StartICD10CMInferenceJob` on `*`. Provide the
implementation with `Effect.provide(AWS.ComprehendMedical.StartICD10CMInferenceJobHttp)`.

### Batch ICD-10-CM Inference Jobs
**Example:** Start a Batch Job
```typescript
// init
const startICD10CMInferenceJob = yield* AWS.ComprehendMedical.StartICD10CMInferenceJob();

// runtime
const job = yield* startICD10CMInferenceJob({
  InputDataConfig: { S3Bucket: "my-input-bucket", S3Key: "notes/" },
  OutputDataConfig: { S3Bucket: "my-output-bucket" },
  DataAccessRoleArn: dataAccessRole.roleArn,
  LanguageCode: "en",
});
```

@binding

## StartPHIDetectionJob

Runtime binding for `comprehendmedical:StartPHIDetectionJob` — start an asynchronous protected health information (PHI) detection job over a collection of documents in S3. Also grants `iam:PassRole` (conditioned to `comprehendmedical.amazonaws.com`) for the job's data-access role.

Comprehend Medical has no resource-level IAM, so the binding takes no
arguments and grants `comprehendmedical:StartPHIDetectionJob` on `*`. Provide the
implementation with `Effect.provide(AWS.ComprehendMedical.StartPHIDetectionJobHttp)`.

### Batch PHI Detection Jobs
**Example:** Start a Batch Job
```typescript
// init
const startPHIDetectionJob = yield* AWS.ComprehendMedical.StartPHIDetectionJob();

// runtime
const job = yield* startPHIDetectionJob({
  InputDataConfig: { S3Bucket: "my-input-bucket", S3Key: "notes/" },
  OutputDataConfig: { S3Bucket: "my-output-bucket" },
  DataAccessRoleArn: dataAccessRole.roleArn,
  LanguageCode: "en",
});
```

@binding

## StartRxNormInferenceJob

Runtime binding for `comprehendmedical:StartRxNormInferenceJob` — start an asynchronous RxNorm ontology linking job over a collection of documents in S3. Also grants `iam:PassRole` (conditioned to `comprehendmedical.amazonaws.com`) for the job's data-access role.

Comprehend Medical has no resource-level IAM, so the binding takes no
arguments and grants `comprehendmedical:StartRxNormInferenceJob` on `*`. Provide the
implementation with `Effect.provide(AWS.ComprehendMedical.StartRxNormInferenceJobHttp)`.

### Batch RxNorm Inference Jobs
**Example:** Start a Batch Job
```typescript
// init
const startRxNormInferenceJob = yield* AWS.ComprehendMedical.StartRxNormInferenceJob();

// runtime
const job = yield* startRxNormInferenceJob({
  InputDataConfig: { S3Bucket: "my-input-bucket", S3Key: "notes/" },
  OutputDataConfig: { S3Bucket: "my-output-bucket" },
  DataAccessRoleArn: dataAccessRole.roleArn,
  LanguageCode: "en",
});
```

@binding

## StartSNOMEDCTInferenceJob

Runtime binding for `comprehendmedical:StartSNOMEDCTInferenceJob` — start an asynchronous SNOMED CT ontology linking job over a collection of documents in S3. Also grants `iam:PassRole` (conditioned to `comprehendmedical.amazonaws.com`) for the job's data-access role.

Comprehend Medical has no resource-level IAM, so the binding takes no
arguments and grants `comprehendmedical:StartSNOMEDCTInferenceJob` on `*`. Provide the
implementation with `Effect.provide(AWS.ComprehendMedical.StartSNOMEDCTInferenceJobHttp)`.

### Batch SNOMED CT Inference Jobs
**Example:** Start a Batch Job
```typescript
// init
const startSNOMEDCTInferenceJob = yield* AWS.ComprehendMedical.StartSNOMEDCTInferenceJob();

// runtime
const job = yield* startSNOMEDCTInferenceJob({
  InputDataConfig: { S3Bucket: "my-input-bucket", S3Key: "notes/" },
  OutputDataConfig: { S3Bucket: "my-output-bucket" },
  DataAccessRoleArn: dataAccessRole.roleArn,
  LanguageCode: "en",
});
```

@binding

## StopEntitiesDetectionV2Job

Runtime binding for `comprehendmedical:StopEntitiesDetectionV2Job` — stop an in-progress asynchronous medical entity detection job.

Comprehend Medical has no resource-level IAM, so the binding takes no
arguments and grants `comprehendmedical:StopEntitiesDetectionV2Job` on `*`. Provide the
implementation with `Effect.provide(AWS.ComprehendMedical.StopEntitiesDetectionV2JobHttp)`.

### Batch Entity Detection Jobs
**Example:** Stop a Running Job
```typescript
// init
const stopEntitiesDetectionV2Job = yield* AWS.ComprehendMedical.StopEntitiesDetectionV2Job();

// runtime
yield* stopEntitiesDetectionV2Job({ JobId: jobId });
```

@binding

## StopICD10CMInferenceJob

Runtime binding for `comprehendmedical:StopICD10CMInferenceJob` — stop an in-progress asynchronous ICD-10-CM ontology linking job.

Comprehend Medical has no resource-level IAM, so the binding takes no
arguments and grants `comprehendmedical:StopICD10CMInferenceJob` on `*`. Provide the
implementation with `Effect.provide(AWS.ComprehendMedical.StopICD10CMInferenceJobHttp)`.

### Batch ICD-10-CM Inference Jobs
**Example:** Stop a Running Job
```typescript
// init
const stopICD10CMInferenceJob = yield* AWS.ComprehendMedical.StopICD10CMInferenceJob();

// runtime
yield* stopICD10CMInferenceJob({ JobId: jobId });
```

@binding

## StopPHIDetectionJob

Runtime binding for `comprehendmedical:StopPHIDetectionJob` — stop an in-progress asynchronous protected health information (PHI) detection job.

Comprehend Medical has no resource-level IAM, so the binding takes no
arguments and grants `comprehendmedical:StopPHIDetectionJob` on `*`. Provide the
implementation with `Effect.provide(AWS.ComprehendMedical.StopPHIDetectionJobHttp)`.

### Batch PHI Detection Jobs
**Example:** Stop a Running Job
```typescript
// init
const stopPHIDetectionJob = yield* AWS.ComprehendMedical.StopPHIDetectionJob();

// runtime
yield* stopPHIDetectionJob({ JobId: jobId });
```

@binding

## StopRxNormInferenceJob

Runtime binding for `comprehendmedical:StopRxNormInferenceJob` — stop an in-progress asynchronous RxNorm ontology linking job.

Comprehend Medical has no resource-level IAM, so the binding takes no
arguments and grants `comprehendmedical:StopRxNormInferenceJob` on `*`. Provide the
implementation with `Effect.provide(AWS.ComprehendMedical.StopRxNormInferenceJobHttp)`.

### Batch RxNorm Inference Jobs
**Example:** Stop a Running Job
```typescript
// init
const stopRxNormInferenceJob = yield* AWS.ComprehendMedical.StopRxNormInferenceJob();

// runtime
yield* stopRxNormInferenceJob({ JobId: jobId });
```

@binding

## StopSNOMEDCTInferenceJob

Runtime binding for `comprehendmedical:StopSNOMEDCTInferenceJob` — stop an in-progress asynchronous SNOMED CT ontology linking job.

Comprehend Medical has no resource-level IAM, so the binding takes no
arguments and grants `comprehendmedical:StopSNOMEDCTInferenceJob` on `*`. Provide the
implementation with `Effect.provide(AWS.ComprehendMedical.StopSNOMEDCTInferenceJobHttp)`.

### Batch SNOMED CT Inference Jobs
**Example:** Stop a Running Job
```typescript
// init
const stopSNOMEDCTInferenceJob = yield* AWS.ComprehendMedical.StopSNOMEDCTInferenceJob();

// runtime
yield* stopSNOMEDCTInferenceJob({ JobId: jobId });
```

@binding
