<!-- Docs for the generated AWS.Transcribe bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## CreateCallAnalyticsCategory

Runtime binding for `transcribe:CreateCallAnalyticsCategory` — create a Call Analytics category whose rules automatically flag matching calls (e.g. long silence, specific phrases, negative sentiment).

Amazon Transcribe batch actions have no resource-level IAM; the host is
granted `transcribe:CreateCallAnalyticsCategory` on `*`.

### Call Analytics Categories
**Example:** Create a Call Analytics Category
```typescript
// init
const createCallAnalyticsCategory = yield* AWS.Transcribe.CreateCallAnalyticsCategory();

// runtime
yield* createCallAnalyticsCategory({
  CategoryName: "long-silence",
  Rules: [{ NonTalkTimeFilter: { Threshold: 30000 } }],
});
```

@binding

## CreateMedicalVocabulary

Runtime binding for `transcribe:CreateMedicalVocabulary` — create a custom medical vocabulary from a text file in S3 (asynchronous: created `PENDING`, poll to `READY` with {@link GetMedicalVocabulary}).

Amazon Transcribe batch actions have no resource-level IAM; the host is
granted `transcribe:CreateMedicalVocabulary` on `*`.

### Medical Vocabularies
**Example:** Create a Medical Vocabulary
```typescript
// init
const createMedicalVocabulary = yield* AWS.Transcribe.CreateMedicalVocabulary();

// runtime
yield* createMedicalVocabulary({
  VocabularyName: "clinic-vocabulary",
  LanguageCode: "en-US",
  VocabularyFileUri: "s3://my-bucket/vocab.txt",
});
```

@binding

## CreateVocabulary

Runtime binding for `transcribe:CreateVocabulary` — create a custom vocabulary that improves transcription accuracy for domain-specific terms (e.g. per-tenant vocabularies created at runtime).

Vocabulary processing is asynchronous: the vocabulary is created in the `PENDING` state and must reach `READY` (poll with {@link GetVocabulary}) before a transcription job can reference it.

Amazon Transcribe batch actions have no resource-level IAM; the host is
granted `transcribe:CreateVocabulary` on `*`.

### Custom Vocabularies
**Example:** Create a Custom Vocabulary
```typescript
// init
const createVocabulary = yield* AWS.Transcribe.CreateVocabulary();

// runtime
const { VocabularyState } = yield* createVocabulary({
  VocabularyName: "tenant-123-vocabulary",
  LanguageCode: "en-US",
  Phrases: ["Alchemy", "workerd"],
});
```

@binding

## CreateVocabularyFilter

Runtime binding for `transcribe:CreateVocabularyFilter` — create a vocabulary filter that masks, removes, or flags unwanted words in transcription output.

Amazon Transcribe batch actions have no resource-level IAM; the host is
granted `transcribe:CreateVocabularyFilter` on `*`.

### Vocabulary Filters
**Example:** Create a Vocabulary Filter
```typescript
// init
const createVocabularyFilter = yield* AWS.Transcribe.CreateVocabularyFilter();

// runtime
yield* createVocabularyFilter({
  VocabularyFilterName: "profanity-filter",
  LanguageCode: "en-US",
  Words: ["unwanted", "words"],
});
```

@binding

## DeleteCallAnalyticsCategory

Runtime binding for `transcribe:DeleteCallAnalyticsCategory` — delete a Call Analytics category.

Amazon Transcribe batch actions have no resource-level IAM; the host is
granted `transcribe:DeleteCallAnalyticsCategory` on `*`.

### Call Analytics Categories
**Example:** Delete a Call Analytics Category
```typescript
// init
const deleteCallAnalyticsCategory = yield* AWS.Transcribe.DeleteCallAnalyticsCategory();

// runtime
yield* deleteCallAnalyticsCategory({ CategoryName: "long-silence" });
```

@binding

## DeleteCallAnalyticsJob

Runtime binding for `transcribe:DeleteCallAnalyticsJob` — delete a Call Analytics job.

Amazon Transcribe batch actions have no resource-level IAM; the host is
granted `transcribe:DeleteCallAnalyticsJob` on `*`.

### Call Analytics Jobs
**Example:** Delete a Call Analytics Job
```typescript
// init
const deleteCallAnalyticsJob = yield* AWS.Transcribe.DeleteCallAnalyticsJob();

// runtime
yield* deleteCallAnalyticsJob({ CallAnalyticsJobName: "my-call" });
```

@binding

## DeleteLanguageModel

Runtime binding for `transcribe:DeleteLanguageModel` — delete a custom language model.

Amazon Transcribe batch actions have no resource-level IAM; the host is
granted `transcribe:DeleteLanguageModel` on `*`.

### Custom Language Models
**Example:** Delete a Custom Language Model
```typescript
// init
const deleteLanguageModel = yield* AWS.Transcribe.DeleteLanguageModel();

// runtime
yield* deleteLanguageModel({ ModelName: "my-domain-model" });
```

@binding

## DeleteMedicalScribeJob

Runtime binding for `transcribe:DeleteMedicalScribeJob` — delete a Medical Scribe job.

Amazon Transcribe batch actions have no resource-level IAM; the host is
granted `transcribe:DeleteMedicalScribeJob` on `*`.

### Medical Scribe Jobs
**Example:** Delete a Medical Scribe Job
```typescript
// init
const deleteMedicalScribeJob = yield* AWS.Transcribe.DeleteMedicalScribeJob();

// runtime
yield* deleteMedicalScribeJob({ MedicalScribeJobName: "my-visit" });
```

@binding

## DeleteMedicalTranscriptionJob

Runtime binding for `transcribe:DeleteMedicalTranscriptionJob` — delete a medical transcription job.

Amazon Transcribe batch actions have no resource-level IAM; the host is
granted `transcribe:DeleteMedicalTranscriptionJob` on `*`.

### Medical Transcription Jobs
**Example:** Delete a Medical Transcription Job
```typescript
// init
const deleteMedicalTranscriptionJob = yield* AWS.Transcribe.DeleteMedicalTranscriptionJob();

// runtime
yield* deleteMedicalTranscriptionJob({ MedicalTranscriptionJobName: "my-medical-job" });
```

@binding

## DeleteMedicalVocabulary

Runtime binding for `transcribe:DeleteMedicalVocabulary` — delete a medical vocabulary.

Amazon Transcribe batch actions have no resource-level IAM; the host is
granted `transcribe:DeleteMedicalVocabulary` on `*`.

### Medical Vocabularies
**Example:** Delete a Medical Vocabulary
```typescript
// init
const deleteMedicalVocabulary = yield* AWS.Transcribe.DeleteMedicalVocabulary();

// runtime
yield* deleteMedicalVocabulary({ VocabularyName: "clinic-vocabulary" });
```

@binding

## DeleteTranscriptionJob

Runtime binding for `transcribe:DeleteTranscriptionJob` — delete a batch transcription job and its transcript from the service-managed output location.

Amazon Transcribe batch actions have no resource-level IAM; the host is
granted `transcribe:DeleteTranscriptionJob` on `*`.

### Batch Transcription Jobs
**Example:** Delete a Transcription Job
```typescript
// init
const deleteTranscriptionJob = yield* AWS.Transcribe.DeleteTranscriptionJob();

// runtime
yield* deleteTranscriptionJob({ TranscriptionJobName: "my-job" });
```

@binding

## DeleteVocabulary

Runtime binding for `transcribe:DeleteVocabulary` — delete a custom vocabulary.

Amazon Transcribe batch actions have no resource-level IAM; the host is
granted `transcribe:DeleteVocabulary` on `*`.

### Custom Vocabularies
**Example:** Delete a Custom Vocabulary
```typescript
// init
const deleteVocabulary = yield* AWS.Transcribe.DeleteVocabulary();

// runtime
yield* deleteVocabulary({ VocabularyName: "tenant-123-vocabulary" });
```

@binding

## DeleteVocabularyFilter

Runtime binding for `transcribe:DeleteVocabularyFilter` — delete a vocabulary filter.

Amazon Transcribe batch actions have no resource-level IAM; the host is
granted `transcribe:DeleteVocabularyFilter` on `*`.

### Vocabulary Filters
**Example:** Delete a Vocabulary Filter
```typescript
// init
const deleteVocabularyFilter = yield* AWS.Transcribe.DeleteVocabularyFilter();

// runtime
yield* deleteVocabularyFilter({ VocabularyFilterName: "profanity-filter" });
```

@binding

## DescribeLanguageModel

Runtime binding for `transcribe:DescribeLanguageModel` — read a custom language model's training status and metadata.

Amazon Transcribe batch actions have no resource-level IAM; the host is
granted `transcribe:DescribeLanguageModel` on `*`.

### Custom Language Models
**Example:** Describe a Custom Language Model
```typescript
// init
const describeLanguageModel = yield* AWS.Transcribe.DescribeLanguageModel();

// runtime
const { LanguageModel } = yield* describeLanguageModel({
  ModelName: "my-domain-model",
});
```

@binding

## GetCallAnalyticsCategory

Runtime binding for `transcribe:GetCallAnalyticsCategory` — read a Call Analytics category's rules.

Amazon Transcribe batch actions have no resource-level IAM; the host is
granted `transcribe:GetCallAnalyticsCategory` on `*`.

### Call Analytics Categories
**Example:** Get a Call Analytics Category
```typescript
// init
const getCallAnalyticsCategory = yield* AWS.Transcribe.GetCallAnalyticsCategory();

// runtime
const { CategoryProperties } = yield* getCallAnalyticsCategory({
  CategoryName: "long-silence",
});
```

@binding

## GetCallAnalyticsJob

Runtime binding for `transcribe:GetCallAnalyticsJob` — read a Call Analytics job's status and, once complete, the transcript location.

Amazon Transcribe batch actions have no resource-level IAM; the host is
granted `transcribe:GetCallAnalyticsJob` on `*`.

### Call Analytics Jobs
**Example:** Poll a Call Analytics Job
```typescript
// init
const getCallAnalyticsJob = yield* AWS.Transcribe.GetCallAnalyticsJob();

// runtime
const { CallAnalyticsJob } = yield* getCallAnalyticsJob({
  CallAnalyticsJobName: "my-call",
});
```

@binding

## GetMedicalScribeJob

Runtime binding for `transcribe:GetMedicalScribeJob` — read a Medical Scribe job's status and, once complete, the clinical note and transcript locations.

Amazon Transcribe batch actions have no resource-level IAM; the host is
granted `transcribe:GetMedicalScribeJob` on `*`.

### Medical Scribe Jobs
**Example:** Poll a Medical Scribe Job
```typescript
// init
const getMedicalScribeJob = yield* AWS.Transcribe.GetMedicalScribeJob();

// runtime
const { MedicalScribeJob } = yield* getMedicalScribeJob({
  MedicalScribeJobName: "my-visit",
});
```

@binding

## GetMedicalTranscriptionJob

Runtime binding for `transcribe:GetMedicalTranscriptionJob` — read a medical transcription job's status and transcript location.

Amazon Transcribe batch actions have no resource-level IAM; the host is
granted `transcribe:GetMedicalTranscriptionJob` on `*`.

### Medical Transcription Jobs
**Example:** Poll a Medical Transcription Job
```typescript
// init
const getMedicalTranscriptionJob = yield* AWS.Transcribe.GetMedicalTranscriptionJob();

// runtime
const { MedicalTranscriptionJob } = yield* getMedicalTranscriptionJob({
  MedicalTranscriptionJobName: "my-medical-job",
});
```

@binding

## GetMedicalVocabulary

Runtime binding for `transcribe:GetMedicalVocabulary` — read a medical vocabulary's processing state and download URI.

Amazon Transcribe batch actions have no resource-level IAM; the host is
granted `transcribe:GetMedicalVocabulary` on `*`.

### Medical Vocabularies
**Example:** Poll a Medical Vocabulary
```typescript
// init
const getMedicalVocabulary = yield* AWS.Transcribe.GetMedicalVocabulary();

// runtime
const { VocabularyState } = yield* getMedicalVocabulary({
  VocabularyName: "clinic-vocabulary",
});
```

@binding

## GetTranscriptionJob

Runtime binding for `transcribe:GetTranscriptionJob` — read the status and
result of a batch transcription job started with
{@link StartTranscriptionJob}.

Account-scoped (no resource to manage): the binding takes no arguments and
grants the function `transcribe:GetTranscriptionJob` (the action has no
resource-level IAM). Poll `TranscriptionJob.TranscriptionJobStatus` until
it reaches `COMPLETED` or `FAILED`.

### Polling a Transcription Job
**Example:** Poll a Job to Completion
```typescript
// init
const getJob = yield* AWS.Transcribe.GetTranscriptionJob();

// runtime
const { TranscriptionJob } = yield* getJob({
  TranscriptionJobName: "my-job",
});
const status = TranscriptionJob?.TranscriptionJobStatus;
```

@binding

## GetVocabulary

Runtime binding for `transcribe:GetVocabulary` — read a custom vocabulary's processing state and download URI.

Amazon Transcribe batch actions have no resource-level IAM; the host is
granted `transcribe:GetVocabulary` on `*`.

### Custom Vocabularies
**Example:** Poll a Custom Vocabulary
```typescript
// init
const getVocabulary = yield* AWS.Transcribe.GetVocabulary();

// runtime
const { VocabularyState } = yield* getVocabulary({
  VocabularyName: "tenant-123-vocabulary",
});
```

@binding

## GetVocabularyFilter

Runtime binding for `transcribe:GetVocabularyFilter` — read a vocabulary filter's metadata and download URI.

Amazon Transcribe batch actions have no resource-level IAM; the host is
granted `transcribe:GetVocabularyFilter` on `*`.

### Vocabulary Filters
**Example:** Get a Vocabulary Filter
```typescript
// init
const getVocabularyFilter = yield* AWS.Transcribe.GetVocabularyFilter();

// runtime
const { DownloadUri } = yield* getVocabularyFilter({
  VocabularyFilterName: "profanity-filter",
});
```

@binding

## ListCallAnalyticsCategories

Runtime binding for `transcribe:ListCallAnalyticsCategories` — list the Call Analytics categories in the account.

Amazon Transcribe batch actions have no resource-level IAM; the host is
granted `transcribe:ListCallAnalyticsCategories` on `*`.

### Call Analytics Categories
**Example:** List Call Analytics Categories
```typescript
// init
const listCallAnalyticsCategories = yield* AWS.Transcribe.ListCallAnalyticsCategories();

// runtime
const { Categories } = yield* listCallAnalyticsCategories({ MaxResults: 10 });
```

@binding

## ListCallAnalyticsJobs

Runtime binding for `transcribe:ListCallAnalyticsJobs` — list the Call Analytics jobs in the account.

Amazon Transcribe batch actions have no resource-level IAM; the host is
granted `transcribe:ListCallAnalyticsJobs` on `*`.

### Call Analytics Jobs
**Example:** List Call Analytics Jobs
```typescript
// init
const listCallAnalyticsJobs = yield* AWS.Transcribe.ListCallAnalyticsJobs();

// runtime
const { CallAnalyticsJobSummaries } = yield* listCallAnalyticsJobs({ MaxResults: 10 });
```

@binding

## ListLanguageModels

Runtime binding for `transcribe:ListLanguageModels` — list the custom language models in the account.

Amazon Transcribe batch actions have no resource-level IAM; the host is
granted `transcribe:ListLanguageModels` on `*`.

### Custom Language Models
**Example:** List Custom Language Models
```typescript
// init
const listLanguageModels = yield* AWS.Transcribe.ListLanguageModels();

// runtime
const { Models } = yield* listLanguageModels({ MaxResults: 10 });
```

@binding

## ListMedicalScribeJobs

Runtime binding for `transcribe:ListMedicalScribeJobs` — list the Medical Scribe jobs in the account.

Amazon Transcribe batch actions have no resource-level IAM; the host is
granted `transcribe:ListMedicalScribeJobs` on `*`.

### Medical Scribe Jobs
**Example:** List Medical Scribe Jobs
```typescript
// init
const listMedicalScribeJobs = yield* AWS.Transcribe.ListMedicalScribeJobs();

// runtime
const { MedicalScribeJobSummaries } = yield* listMedicalScribeJobs({ MaxResults: 10 });
```

@binding

## ListMedicalTranscriptionJobs

Runtime binding for `transcribe:ListMedicalTranscriptionJobs` — list the medical transcription jobs in the account.

Amazon Transcribe batch actions have no resource-level IAM; the host is
granted `transcribe:ListMedicalTranscriptionJobs` on `*`.

### Medical Transcription Jobs
**Example:** List Medical Transcription Jobs
```typescript
// init
const listMedicalTranscriptionJobs = yield* AWS.Transcribe.ListMedicalTranscriptionJobs();

// runtime
const { MedicalTranscriptionJobSummaries } = yield* listMedicalTranscriptionJobs({ MaxResults: 10 });
```

@binding

## ListMedicalVocabularies

Runtime binding for `transcribe:ListMedicalVocabularies` — list the medical vocabularies in the account.

Amazon Transcribe batch actions have no resource-level IAM; the host is
granted `transcribe:ListMedicalVocabularies` on `*`.

### Medical Vocabularies
**Example:** List Medical Vocabularies
```typescript
// init
const listMedicalVocabularies = yield* AWS.Transcribe.ListMedicalVocabularies();

// runtime
const { Vocabularies } = yield* listMedicalVocabularies({ MaxResults: 10 });
```

@binding

## ListTagsForResource

Runtime binding for `transcribe:ListTagsForResource` — list the tags on a Transcribe resource by ARN.

Amazon Transcribe batch actions have no resource-level IAM; the host is
granted `transcribe:ListTagsForResource` on `*`.

### Tagging
**Example:** List Tags on a Transcribe Resource
```typescript
// init
const listTagsForResource = yield* AWS.Transcribe.ListTagsForResource();

// runtime
const { Tags } = yield* listTagsForResource({
  ResourceArn: "arn:aws:transcribe:us-east-1:123456789012:vocabulary/tenant-123",
});
```

@binding

## ListTranscriptionJobs

Runtime binding for `transcribe:ListTranscriptionJobs` — list the batch transcription jobs in the account, optionally filtered by status or name prefix.

Amazon Transcribe batch actions have no resource-level IAM; the host is
granted `transcribe:ListTranscriptionJobs` on `*`.

### Batch Transcription Jobs
**Example:** List Transcription Jobs
```typescript
// init
const listTranscriptionJobs = yield* AWS.Transcribe.ListTranscriptionJobs();

// runtime
const { TranscriptionJobSummaries } = yield* listTranscriptionJobs({
  Status: "COMPLETED",
  MaxResults: 10,
});
```

@binding

## ListVocabularies

Runtime binding for `transcribe:ListVocabularies` — list the custom vocabularies in the account.

Amazon Transcribe batch actions have no resource-level IAM; the host is
granted `transcribe:ListVocabularies` on `*`.

### Custom Vocabularies
**Example:** List Custom Vocabularies
```typescript
// init
const listVocabularies = yield* AWS.Transcribe.ListVocabularies();

// runtime
const { Vocabularies } = yield* listVocabularies({ MaxResults: 10 });
```

@binding

## ListVocabularyFilters

Runtime binding for `transcribe:ListVocabularyFilters` — list the vocabulary filters in the account.

Amazon Transcribe batch actions have no resource-level IAM; the host is
granted `transcribe:ListVocabularyFilters` on `*`.

### Vocabulary Filters
**Example:** List Vocabulary Filters
```typescript
// init
const listVocabularyFilters = yield* AWS.Transcribe.ListVocabularyFilters();

// runtime
const { VocabularyFilters } = yield* listVocabularyFilters({ MaxResults: 10 });
```

@binding

## StartMedicalTranscriptionJob

Runtime binding for `transcribe:StartMedicalTranscriptionJob` — start an asynchronous medical transcription job over an audio file in S3 (output goes to your bucket).

Amazon Transcribe batch actions have no resource-level IAM; the host is
granted `transcribe:StartMedicalTranscriptionJob` on `*`.

### Medical Transcription Jobs
**Example:** Start a Medical Transcription Job
```typescript
// init
const startMedicalTranscriptionJob = yield* AWS.Transcribe.StartMedicalTranscriptionJob();

// runtime
const { MedicalTranscriptionJob } = yield* startMedicalTranscriptionJob({
  MedicalTranscriptionJobName: "my-medical-job",
  LanguageCode: "en-US",
  Media: { MediaFileUri: "s3://my-bucket/dictation.wav" },
  OutputBucketName: "my-output-bucket",
  Specialty: "PRIMARYCARE",
  Type: "DICTATION",
});
```

@binding

## StartTranscriptionJob

Runtime binding for `transcribe:StartTranscriptionJob` — kick off an
asynchronous batch transcription of an audio/video file stored in S3.

Transcribe batch jobs are account-scoped (no resource to manage): the
binding takes no arguments and grants the function
`transcribe:StartTranscriptionJob` (the action has no resource-level IAM).
The input `Media.MediaFileUri` and the output bucket are S3 locations —
grant the function S3 access to those buckets separately. Poll the job to
completion with {@link GetTranscriptionJob}.

### Starting a Transcription Job
**Example:** Transcribe an S3 Audio File
```typescript
// init
const startJob = yield* AWS.Transcribe.StartTranscriptionJob();

// runtime
const { TranscriptionJob } = yield* startJob({
  TranscriptionJobName: "my-job",
  LanguageCode: "en-US",
  Media: { MediaFileUri: "s3://my-bucket/audio/sample.wav" },
  OutputBucketName: "my-output-bucket",
});
```

@binding

## TagResource

Runtime binding for `transcribe:TagResource` — add tags to a Transcribe resource (jobs, vocabularies, filters, categories, or models) by ARN.

Amazon Transcribe batch actions have no resource-level IAM; the host is
granted `transcribe:TagResource` on `*`.

### Tagging
**Example:** Tag a Transcribe Resource
```typescript
// init
const tagResource = yield* AWS.Transcribe.TagResource();

// runtime
yield* tagResource({
  ResourceArn: "arn:aws:transcribe:us-east-1:123456789012:vocabulary/tenant-123",
  Tags: [{ Key: "tenant", Value: "123" }],
});
```

@binding

## UntagResource

Runtime binding for `transcribe:UntagResource` — remove tags from a Transcribe resource by ARN.

Amazon Transcribe batch actions have no resource-level IAM; the host is
granted `transcribe:UntagResource` on `*`.

### Tagging
**Example:** Untag a Transcribe Resource
```typescript
// init
const untagResource = yield* AWS.Transcribe.UntagResource();

// runtime
yield* untagResource({
  ResourceArn: "arn:aws:transcribe:us-east-1:123456789012:vocabulary/tenant-123",
  TagKeys: ["tenant"],
});
```

@binding

## UpdateCallAnalyticsCategory

Runtime binding for `transcribe:UpdateCallAnalyticsCategory` — replace a Call Analytics category's rules.

Amazon Transcribe batch actions have no resource-level IAM; the host is
granted `transcribe:UpdateCallAnalyticsCategory` on `*`.

### Call Analytics Categories
**Example:** Update a Call Analytics Category
```typescript
// init
const updateCallAnalyticsCategory = yield* AWS.Transcribe.UpdateCallAnalyticsCategory();

// runtime
yield* updateCallAnalyticsCategory({
  CategoryName: "long-silence",
  Rules: [{ NonTalkTimeFilter: { Threshold: 60000 } }],
});
```

@binding

## UpdateMedicalVocabulary

Runtime binding for `transcribe:UpdateMedicalVocabulary` — replace a medical vocabulary with a new source file.

Amazon Transcribe batch actions have no resource-level IAM; the host is
granted `transcribe:UpdateMedicalVocabulary` on `*`.

### Medical Vocabularies
**Example:** Update a Medical Vocabulary
```typescript
// init
const updateMedicalVocabulary = yield* AWS.Transcribe.UpdateMedicalVocabulary();

// runtime
yield* updateMedicalVocabulary({
  VocabularyName: "clinic-vocabulary",
  LanguageCode: "en-US",
  VocabularyFileUri: "s3://my-bucket/vocab-v2.txt",
});
```

@binding

## UpdateVocabulary

Runtime binding for `transcribe:UpdateVocabulary` — replace a custom vocabulary's phrases (the vocabulary re-enters `PENDING` while it reprocesses).

Amazon Transcribe batch actions have no resource-level IAM; the host is
granted `transcribe:UpdateVocabulary` on `*`.

### Custom Vocabularies
**Example:** Update a Custom Vocabulary
```typescript
// init
const updateVocabulary = yield* AWS.Transcribe.UpdateVocabulary();

// runtime
yield* updateVocabulary({
  VocabularyName: "tenant-123-vocabulary",
  LanguageCode: "en-US",
  Phrases: ["Alchemy", "workerd", "distilled"],
});
```

@binding

## UpdateVocabularyFilter

Runtime binding for `transcribe:UpdateVocabularyFilter` — replace a vocabulary filter's word list.

Amazon Transcribe batch actions have no resource-level IAM; the host is
granted `transcribe:UpdateVocabularyFilter` on `*`.

### Vocabulary Filters
**Example:** Update a Vocabulary Filter
```typescript
// init
const updateVocabularyFilter = yield* AWS.Transcribe.UpdateVocabularyFilter();

// runtime
yield* updateVocabularyFilter({
  VocabularyFilterName: "profanity-filter",
  Words: ["unwanted", "words", "more"],
});
```

@binding
