<!-- Docs for the generated AWS.Translate bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## DescribeTextTranslationJob

Runtime binding for `translate:DescribeTextTranslationJob` — get the
properties of an asynchronous batch translation job (status, language
pair, input/output locations, document counts).

### Batch Translation Jobs
**Example:** Describe a batch translation job
```typescript
// init
const describeJob = yield* AWS.Translate.DescribeTextTranslationJob();

// runtime
const result = yield* describeJob({ JobId: job.JobId! });
// result.TextTranslationJobProperties?.JobStatus
```

@binding

## GetParallelData

Runtime binding for `translate:GetParallelData` — retrieve a parallel
data resource's properties and a presigned download location for its
input file.

### Reading Parallel Data
**Example:** Read a parallel data resource
```typescript
// init
const getParallelData = yield* AWS.Translate.GetParallelData();

// runtime
const result = yield* getParallelData({ Name: examples.parallelDataName });
// result.ParallelDataProperties?.Status === "ACTIVE"
```

@binding

## GetTerminology

Runtime binding for `translate:GetTerminology` — retrieve a custom
terminology's properties and a presigned download location for its
term-pair file.

### Reading Terminologies
**Example:** Read a terminology's properties
```typescript
// init
const getTerminology = yield* AWS.Translate.GetTerminology();

// runtime
const result = yield* getTerminology({ Name: glossary.terminologyName });
// result.TerminologyProperties?.TermCount
// result.TerminologyDataLocation?.Location — presigned download URL
```

@binding

## ListLanguages

Runtime binding for `translate:ListLanguages` — list the languages
(RFC-5646 codes and display names) Amazon Translate supports.

### Discovering Languages
**Example:** List supported languages
```typescript
// init
const listLanguages = yield* AWS.Translate.ListLanguages();

// runtime
const result = yield* listLanguages({ MaxResults: 100 });
// result.Languages -> [{ LanguageCode: "es", LanguageName: "Spanish" }, …]
```

@binding

## ListParallelData

Runtime binding for `translate:ListParallelData` — list the parallel data
resources in the account and region.

### Reading Parallel Data
**Example:** List parallel data resources
```typescript
// init
const listParallelData = yield* AWS.Translate.ListParallelData();

// runtime
const result = yield* listParallelData({ MaxResults: 50 });
// result.ParallelDataPropertiesList -> [{ Name, Arn, Status, … }, …]
```

@binding

## ListTerminologies

Runtime binding for `translate:ListTerminologies` — list the custom
terminologies in the account and region.

### Reading Terminologies
**Example:** List terminologies
```typescript
// init
const listTerminologies = yield* AWS.Translate.ListTerminologies();

// runtime
const result = yield* listTerminologies({ MaxResults: 50 });
// result.TerminologyPropertiesList -> [{ Name, Arn, TermCount, … }, …]
```

@binding

## ListTextTranslationJobs

Runtime binding for `translate:ListTextTranslationJobs` — list the batch
translation jobs submitted in the account and region, optionally filtered
by name, status, or submission time.

### Batch Translation Jobs
**Example:** List batch translation jobs
```typescript
// init
const listJobs = yield* AWS.Translate.ListTextTranslationJobs();

// runtime
const result = yield* listJobs({
  Filter: { JobStatus: "IN_PROGRESS" },
  MaxResults: 25,
});
// result.TextTranslationJobPropertiesList -> [{ JobId, JobStatus, … }, …]
```

@binding

## StopTextTranslationJob

Runtime binding for `translate:StopTextTranslationJob` — stop an
asynchronous batch translation job that is in progress. An `IN_PROGRESS`
job is marked `STOP_REQUESTED` and later `STOPPED`; a job that completes
first ends `COMPLETED`.

### Batch Translation Jobs
**Example:** Stop a batch translation job
```typescript
// init
const stopJob = yield* AWS.Translate.StopTextTranslationJob();

// runtime
const result = yield* stopJob({ JobId: job.JobId! });
// result.JobStatus === "STOP_REQUESTED"
```

@binding

## TranslateDocument

Runtime binding for `translate:TranslateDocument` — synchronously
translate a whole document (plain text, HTML, or Word) between a source
and a target language.

One of the two language codes must be `en` (English). The document
content and the translated result are sensitive blobs — the response's
`TranslatedDocument.Content` decodes as `Redacted<Uint8Array>`.

### Translating Documents
**Example:** Translate a plain-text document
```typescript
// init
const translateDocument = yield* AWS.Translate.TranslateDocument();

// runtime
const result = yield* translateDocument({
  Document: {
    Content: new TextEncoder().encode("Good morning!"),
    ContentType: "text/plain",
  },
  SourceLanguageCode: "en",
  TargetLanguageCode: "es",
});
const bytes = Redacted.value(result.TranslatedDocument.Content as Redacted.Redacted<Uint8Array>);
// new TextDecoder().decode(bytes) === "¡Buenos días!"
```

@binding

## TranslateText

Runtime binding for `translate:TranslateText` — translate text between
a source and a target language.

Translate is a pure pay-per-call service with no resource to manage:
the binding takes no arguments and grants the function
`translate:TranslateText` (the action has no resource-level IAM).
Language codes follow RFC 5646 (`en`, `es`, `de`, ...); pass `auto` as
the source to let Translate detect the language (this additionally
calls Comprehend under the hood).

### Translating Text
**Example:** Translate English to Spanish
```typescript
// init
const translateText = yield* AWS.Translate.TranslateText();

// runtime
const result = yield* translateText({
  Text: "Hello, world!",
  SourceLanguageCode: "en",
  TargetLanguageCode: "es",
});
// result.TranslatedText === "¡Hola, mundo!"
```

@binding
