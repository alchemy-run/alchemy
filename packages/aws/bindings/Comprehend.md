<!-- Docs for the generated AWS.Comprehend bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## BatchDetectDominantLanguage

Runtime binding for `comprehend:BatchDetectDominantLanguage` — determine the dominant language for a batch of up to 25 documents in a single call.

The response carries a `ResultList` (index-aligned with `TextList`) and an
`ErrorList` for documents that could not be processed. Like all Comprehend
real-time APIs the action has no resource-level IAM, so the binding takes
no arguments and grants the action on `*`.

### Batch Real-Time Analysis
**Example:** DominantLanguage for a Batch of Documents
```typescript
// init
const batchDetectDominantLanguage = yield* AWS.Comprehend.BatchDetectDominantLanguage();

// runtime
const result = yield* batchDetectDominantLanguage({
  TextList: ["I love this product!", "The delivery was late."],
});
// result.ResultList[0].Languages[0].LanguageCode === "en"
```

@binding

## BatchDetectEntities

Runtime binding for `comprehend:BatchDetectEntities` — detect named entities for a batch of up to 25 documents in a single call.

The response carries a `ResultList` (index-aligned with `TextList`) and an
`ErrorList` for documents that could not be processed. Like all Comprehend
real-time APIs the action has no resource-level IAM, so the binding takes
no arguments and grants the action on `*`.

### Batch Real-Time Analysis
**Example:** Entities for a Batch of Documents
```typescript
// init
const batchDetectEntities = yield* AWS.Comprehend.BatchDetectEntities();

// runtime
const result = yield* batchDetectEntities({
  TextList: ["I love this product!", "The delivery was late."],
  LanguageCode: "en",
});
// result.ResultList[0].Entities
```

@binding

## BatchDetectKeyPhrases

Runtime binding for `comprehend:BatchDetectKeyPhrases` — extract key phrases for a batch of up to 25 documents in a single call.

The response carries a `ResultList` (index-aligned with `TextList`) and an
`ErrorList` for documents that could not be processed. Like all Comprehend
real-time APIs the action has no resource-level IAM, so the binding takes
no arguments and grants the action on `*`.

### Batch Real-Time Analysis
**Example:** KeyPhrases for a Batch of Documents
```typescript
// init
const batchDetectKeyPhrases = yield* AWS.Comprehend.BatchDetectKeyPhrases();

// runtime
const result = yield* batchDetectKeyPhrases({
  TextList: ["I love this product!", "The delivery was late."],
  LanguageCode: "en",
});
// result.ResultList[0].KeyPhrases
```

@binding

## BatchDetectSentiment

Runtime binding for `comprehend:BatchDetectSentiment` — infer the prevailing sentiment for a batch of up to 25 documents in a single call.

The response carries a `ResultList` (index-aligned with `TextList`) and an
`ErrorList` for documents that could not be processed. Like all Comprehend
real-time APIs the action has no resource-level IAM, so the binding takes
no arguments and grants the action on `*`.

### Batch Real-Time Analysis
**Example:** Sentiment for a Batch of Documents
```typescript
// init
const batchDetectSentiment = yield* AWS.Comprehend.BatchDetectSentiment();

// runtime
const result = yield* batchDetectSentiment({
  TextList: ["I love this product!", "The delivery was late."],
  LanguageCode: "en",
});
// result.ResultList[0].Sentiment === "POSITIVE"
```

@binding

## BatchDetectSyntax

Runtime binding for `comprehend:BatchDetectSyntax` — tokenize and label parts of speech for a batch of up to 25 documents in a single call.

The response carries a `ResultList` (index-aligned with `TextList`) and an
`ErrorList` for documents that could not be processed. Like all Comprehend
real-time APIs the action has no resource-level IAM, so the binding takes
no arguments and grants the action on `*`.

### Batch Real-Time Analysis
**Example:** Syntax for a Batch of Documents
```typescript
// init
const batchDetectSyntax = yield* AWS.Comprehend.BatchDetectSyntax();

// runtime
const result = yield* batchDetectSyntax({
  TextList: ["I love this product!", "The delivery was late."],
  LanguageCode: "en",
});
// result.ResultList[0].SyntaxTokens
```

@binding

## BatchDetectTargetedSentiment

Runtime binding for `comprehend:BatchDetectTargetedSentiment` — analyze entity-level (targeted) sentiment for a batch of up to 25 documents in a single call.

The response carries a `ResultList` (index-aligned with `TextList`) and an
`ErrorList` for documents that could not be processed. Like all Comprehend
real-time APIs the action has no resource-level IAM, so the binding takes
no arguments and grants the action on `*`.

### Batch Real-Time Analysis
**Example:** TargetedSentiment for a Batch of Documents
```typescript
// init
const batchDetectTargetedSentiment = yield* AWS.Comprehend.BatchDetectTargetedSentiment();

// runtime
const result = yield* batchDetectTargetedSentiment({
  TextList: ["I love this product!", "The delivery was late."],
  LanguageCode: "en",
});
// result.ResultList[0].Entities[…].Mentions
```

@binding

## ClassifyDocument

Runtime binding for `comprehend:ClassifyDocument` — classify a single
document in real time against a custom classifier endpoint or a
Comprehend prebuilt model ARN (`EndpointArn`).

The binding takes no arguments and grants the action on `*` — endpoints
are addressed per-request via `EndpointArn`, so the grant cannot be
scoped tighter at deploy time.

### Real-Time Analysis
**Example:** Classify a Document Against a Custom Endpoint
```typescript
// init
const classifyDocument = yield* AWS.Comprehend.ClassifyDocument();

// runtime
const result = yield* classifyDocument({
  Text: "Subject: your invoice for March is attached",
  EndpointArn: endpointArn,
});
// result.Classes: [{ Name: "INVOICE", Score: 0.98 }, …]
```

@binding

## ContainsPiiEntities

Runtime binding for `comprehend:ContainsPiiEntities` — check whether the
input text contains personally identifiable information, returning the
PII entity-type labels present (without offsets; use
{@link DetectPiiEntities} to locate them).

The binding takes no arguments and grants the action on `*` (the action
has no resource-level IAM).

### Real-Time Analysis
**Example:** Check a Document for PII
```typescript
// init
const containsPiiEntities = yield* AWS.Comprehend.ContainsPiiEntities();

// runtime
const result = yield* containsPiiEntities({
  Text: "My name is Jane Doe and my email is jane@example.com.",
  LanguageCode: "en",
});
// result.Labels: [{ Name: "NAME" }, { Name: "EMAIL" }]
```

@binding

## DescribeDocumentClassificationJob

Runtime binding for `comprehend:DescribeDocumentClassificationJob` — get the
properties (status, input/output config, timings) of an asynchronous
document classification job started with {@link StartDocumentClassificationJob}.

The binding takes no arguments and grants the action on `*` (job APIs
have no resource-level IAM).

### Monitoring Analysis Jobs
**Example:** Poll a DocumentClassification Job
```typescript
// init
const describeDocumentClassificationJob = yield* AWS.Comprehend.DescribeDocumentClassificationJob();

// runtime
const job = yield* describeDocumentClassificationJob({ JobId: jobId });
// job.DocumentClassificationJobProperties?.JobStatus: "SUBMITTED" | "IN_PROGRESS" | "COMPLETED" | …
```

@binding

## DescribeDominantLanguageDetectionJob

Runtime binding for `comprehend:DescribeDominantLanguageDetectionJob` — get the
properties (status, input/output config, timings) of an asynchronous
dominant-language detection job started with {@link StartDominantLanguageDetectionJob}.

The binding takes no arguments and grants the action on `*` (job APIs
have no resource-level IAM).

### Monitoring Analysis Jobs
**Example:** Poll a DominantLanguageDetection Job
```typescript
// init
const describeDominantLanguageDetectionJob = yield* AWS.Comprehend.DescribeDominantLanguageDetectionJob();

// runtime
const job = yield* describeDominantLanguageDetectionJob({ JobId: jobId });
// job.DominantLanguageDetectionJobProperties?.JobStatus: "SUBMITTED" | "IN_PROGRESS" | "COMPLETED" | …
```

@binding

## DescribeEntitiesDetectionJob

Runtime binding for `comprehend:DescribeEntitiesDetectionJob` — get the
properties (status, input/output config, timings) of an asynchronous
entity detection job started with {@link StartEntitiesDetectionJob}.

The binding takes no arguments and grants the action on `*` (job APIs
have no resource-level IAM).

### Monitoring Analysis Jobs
**Example:** Poll a EntitiesDetection Job
```typescript
// init
const describeEntitiesDetectionJob = yield* AWS.Comprehend.DescribeEntitiesDetectionJob();

// runtime
const job = yield* describeEntitiesDetectionJob({ JobId: jobId });
// job.EntitiesDetectionJobProperties?.JobStatus: "SUBMITTED" | "IN_PROGRESS" | "COMPLETED" | …
```

@binding

## DescribeEventsDetectionJob

Runtime binding for `comprehend:DescribeEventsDetectionJob` — get the
properties (status, input/output config, timings) of an asynchronous
event detection job started with {@link StartEventsDetectionJob}.

The binding takes no arguments and grants the action on `*` (job APIs
have no resource-level IAM).

### Monitoring Analysis Jobs
**Example:** Poll a EventsDetection Job
```typescript
// init
const describeEventsDetectionJob = yield* AWS.Comprehend.DescribeEventsDetectionJob();

// runtime
const job = yield* describeEventsDetectionJob({ JobId: jobId });
// job.EventsDetectionJobProperties?.JobStatus: "SUBMITTED" | "IN_PROGRESS" | "COMPLETED" | …
```

@binding

## DescribeKeyPhrasesDetectionJob

Runtime binding for `comprehend:DescribeKeyPhrasesDetectionJob` — get the
properties (status, input/output config, timings) of an asynchronous
key-phrase detection job started with {@link StartKeyPhrasesDetectionJob}.

The binding takes no arguments and grants the action on `*` (job APIs
have no resource-level IAM).

### Monitoring Analysis Jobs
**Example:** Poll a KeyPhrasesDetection Job
```typescript
// init
const describeKeyPhrasesDetectionJob = yield* AWS.Comprehend.DescribeKeyPhrasesDetectionJob();

// runtime
const job = yield* describeKeyPhrasesDetectionJob({ JobId: jobId });
// job.KeyPhrasesDetectionJobProperties?.JobStatus: "SUBMITTED" | "IN_PROGRESS" | "COMPLETED" | …
```

@binding

## DescribePiiEntitiesDetectionJob

Runtime binding for `comprehend:DescribePiiEntitiesDetectionJob` — get the
properties (status, input/output config, timings) of an asynchronous
PII entity detection job started with {@link StartPiiEntitiesDetectionJob}.

The binding takes no arguments and grants the action on `*` (job APIs
have no resource-level IAM).

### Monitoring Analysis Jobs
**Example:** Poll a PiiEntitiesDetection Job
```typescript
// init
const describePiiEntitiesDetectionJob = yield* AWS.Comprehend.DescribePiiEntitiesDetectionJob();

// runtime
const job = yield* describePiiEntitiesDetectionJob({ JobId: jobId });
// job.PiiEntitiesDetectionJobProperties?.JobStatus: "SUBMITTED" | "IN_PROGRESS" | "COMPLETED" | …
```

@binding

## DescribeSentimentDetectionJob

Runtime binding for `comprehend:DescribeSentimentDetectionJob` — get the
properties (status, input/output config, timings) of an asynchronous
sentiment detection job started with {@link StartSentimentDetectionJob}.

The binding takes no arguments and grants the action on `*` (job APIs
have no resource-level IAM).

### Monitoring Analysis Jobs
**Example:** Poll a SentimentDetection Job
```typescript
// init
const describeSentimentDetectionJob = yield* AWS.Comprehend.DescribeSentimentDetectionJob();

// runtime
const job = yield* describeSentimentDetectionJob({ JobId: jobId });
// job.SentimentDetectionJobProperties?.JobStatus: "SUBMITTED" | "IN_PROGRESS" | "COMPLETED" | …
```

@binding

## DescribeTargetedSentimentDetectionJob

Runtime binding for `comprehend:DescribeTargetedSentimentDetectionJob` — get the
properties (status, input/output config, timings) of an asynchronous
targeted-sentiment detection job started with {@link StartTargetedSentimentDetectionJob}.

The binding takes no arguments and grants the action on `*` (job APIs
have no resource-level IAM).

### Monitoring Analysis Jobs
**Example:** Poll a TargetedSentimentDetection Job
```typescript
// init
const describeTargetedSentimentDetectionJob = yield* AWS.Comprehend.DescribeTargetedSentimentDetectionJob();

// runtime
const job = yield* describeTargetedSentimentDetectionJob({ JobId: jobId });
// job.TargetedSentimentDetectionJobProperties?.JobStatus: "SUBMITTED" | "IN_PROGRESS" | "COMPLETED" | …
```

@binding

## DescribeTopicsDetectionJob

Runtime binding for `comprehend:DescribeTopicsDetectionJob` — get the
properties (status, input/output config, timings) of an asynchronous
topic modeling job started with {@link StartTopicsDetectionJob}.

The binding takes no arguments and grants the action on `*` (job APIs
have no resource-level IAM).

### Monitoring Analysis Jobs
**Example:** Poll a TopicsDetection Job
```typescript
// init
const describeTopicsDetectionJob = yield* AWS.Comprehend.DescribeTopicsDetectionJob();

// runtime
const job = yield* describeTopicsDetectionJob({ JobId: jobId });
// job.TopicsDetectionJobProperties?.JobStatus: "SUBMITTED" | "IN_PROGRESS" | "COMPLETED" | …
```

@binding

## DetectDominantLanguage

Runtime binding for `comprehend:DetectDominantLanguage` — determine the
dominant language of the input text (returns RFC 5646 language codes with
confidence scores).

Comprehend's synchronous detect APIs are pure pay-per-call with no
resource to manage: the binding takes no arguments and grants the action
on `*` (it has no resource-level IAM).

### Real-Time Analysis
**Example:** Detect the Language of a Document
```typescript
// init
const detectDominantLanguage = yield* AWS.Comprehend.DetectDominantLanguage();

// runtime
const result = yield* detectDominantLanguage({
  Text: "Bob ordered two sandwiches yesterday.",
});
// result.Languages[0].LanguageCode === "en"
```

@binding

## DetectEntities

Runtime binding for `comprehend:DetectEntities` — detect named entities
(people, places, organizations, dates, quantities, …) in the input text
using the pre-trained model, or custom entities via a custom entity
recognizer endpoint (`EndpointArn`).

The binding takes no arguments and grants the action on `*` (the action
has no resource-level IAM for the pre-trained model).

### Real-Time Analysis
**Example:** Detect Named Entities
```typescript
// init
const detectEntities = yield* AWS.Comprehend.DetectEntities();

// runtime
const result = yield* detectEntities({
  Text: "Bob moved to Seattle in 2017.",
  LanguageCode: "en",
});
// result.Entities: [{ Type: "PERSON", Text: "Bob" }, { Type: "LOCATION", Text: "Seattle" }, …]
```

@binding

## DetectKeyPhrases

Runtime binding for `comprehend:DetectKeyPhrases` — extract the key noun
phrases of the input text with confidence scores and offsets.

The binding takes no arguments and grants the action on `*` (the action
has no resource-level IAM).

### Real-Time Analysis
**Example:** Extract Key Phrases
```typescript
// init
const detectKeyPhrases = yield* AWS.Comprehend.DetectKeyPhrases();

// runtime
const result = yield* detectKeyPhrases({
  Text: "The quarterly earnings report exceeded analyst expectations.",
  LanguageCode: "en",
});
// result.KeyPhrases: [{ Text: "The quarterly earnings report" }, …]
```

@binding

## DetectPiiEntities

Runtime binding for `comprehend:DetectPiiEntities` — locate personally
identifiable information (names, addresses, bank account numbers, …) in
the input text, with entity type, score, and character offsets.

The binding takes no arguments and grants the action on `*` (the action
has no resource-level IAM). To only test *whether* a document contains
PII, use the cheaper {@link ContainsPiiEntities}.

### Real-Time Analysis
**Example:** Locate PII in a Document
```typescript
// init
const detectPiiEntities = yield* AWS.Comprehend.DetectPiiEntities();

// runtime
const result = yield* detectPiiEntities({
  Text: "My name is Jane Doe and my email is jane@example.com.",
  LanguageCode: "en",
});
// result.Entities: [{ Type: "NAME", BeginOffset: 11, … }, { Type: "EMAIL", … }]
```

@binding

## DetectSentiment

Runtime binding for `comprehend:DetectSentiment` — infer the prevailing
sentiment of a piece of text (`POSITIVE`, `NEGATIVE`, `NEUTRAL`, or
`MIXED`).

Comprehend's synchronous detect APIs are pure pay-per-call with no
resource to manage: the binding takes no arguments and grants the
function `comprehend:DetectSentiment` (the action has no resource-level
IAM).

### Real-Time Analysis
**Example:** Detect Sentiment of a Sentence
```typescript
// init
const detectSentiment = yield* AWS.Comprehend.DetectSentiment();

// runtime
const result = yield* detectSentiment({
  Text: "I love this product, it works wonderfully!",
  LanguageCode: "en",
});
// result.Sentiment === "POSITIVE"
// result.SentimentScore.Positive ~ 0.99
```

@binding

## DetectSyntax

Runtime binding for `comprehend:DetectSyntax` — tokenize the input text
and label each token with its part of speech (noun, verb, adjective, …).

The binding takes no arguments and grants the action on `*` (the action
has no resource-level IAM).

### Real-Time Analysis
**Example:** Parse Parts of Speech
```typescript
// init
const detectSyntax = yield* AWS.Comprehend.DetectSyntax();

// runtime
const result = yield* detectSyntax({
  Text: "The cat sat on the mat.",
  LanguageCode: "en",
});
// result.SyntaxTokens: [{ Text: "cat", PartOfSpeech: { Tag: "NOUN" } }, …]
```

@binding

## DetectTargetedSentiment

Runtime binding for `comprehend:DetectTargetedSentiment` — analyze the
sentiment expressed toward each entity mentioned in the input text
(entity-level sentiment rather than whole-document sentiment).

The binding takes no arguments and grants the action on `*` (the action
has no resource-level IAM).

### Real-Time Analysis
**Example:** Sentiment per Entity
```typescript
// init
const detectTargetedSentiment = yield* AWS.Comprehend.DetectTargetedSentiment();

// runtime
const result = yield* detectTargetedSentiment({
  Text: "The screen is gorgeous but the battery life is disappointing.",
  LanguageCode: "en",
});
// result.Entities[…].Mentions[…].MentionSentiment.Sentiment
```

@binding

## DetectToxicContent

Runtime binding for `comprehend:DetectToxicContent` — run toxicity
analysis over a list of text segments; the response carries one result per
segment with per-label scores (profanity, hate speech, harassment, …).

The binding takes no arguments and grants the action on `*` (the action
has no resource-level IAM).

### Real-Time Analysis
**Example:** Score Text Segments for Toxicity
```typescript
// init
const detectToxicContent = yield* AWS.Comprehend.DetectToxicContent();

// runtime
const result = yield* detectToxicContent({
  TextSegments: [{ Text: "You are a wonderful person." }],
  LanguageCode: "en",
});
// result.ResultList[0].Toxicity ~ 0.01
```

@binding

## ListDocumentClassificationJobs

Runtime binding for `comprehend:ListDocumentClassificationJobs` — list the account's
asynchronous document classification jobs, with optional status/name/time filters.

The binding takes no arguments and grants the action on `*` (job APIs
have no resource-level IAM).

### Monitoring Analysis Jobs
**Example:** List Recent DocumentClassification Jobs
```typescript
// init
const listDocumentClassificationJobs = yield* AWS.Comprehend.ListDocumentClassificationJobs();

// runtime
const page = yield* listDocumentClassificationJobs({
  Filter: { JobStatus: "IN_PROGRESS" },
  MaxResults: 25,
});
// page.DocumentClassificationJobPropertiesList
```

@binding

## ListDominantLanguageDetectionJobs

Runtime binding for `comprehend:ListDominantLanguageDetectionJobs` — list the account's
asynchronous dominant-language detection jobs, with optional status/name/time filters.

The binding takes no arguments and grants the action on `*` (job APIs
have no resource-level IAM).

### Monitoring Analysis Jobs
**Example:** List Recent DominantLanguageDetection Jobs
```typescript
// init
const listDominantLanguageDetectionJobs = yield* AWS.Comprehend.ListDominantLanguageDetectionJobs();

// runtime
const page = yield* listDominantLanguageDetectionJobs({
  Filter: { JobStatus: "IN_PROGRESS" },
  MaxResults: 25,
});
// page.DominantLanguageDetectionJobPropertiesList
```

@binding

## ListEntitiesDetectionJobs

Runtime binding for `comprehend:ListEntitiesDetectionJobs` — list the account's
asynchronous entity detection jobs, with optional status/name/time filters.

The binding takes no arguments and grants the action on `*` (job APIs
have no resource-level IAM).

### Monitoring Analysis Jobs
**Example:** List Recent EntitiesDetection Jobs
```typescript
// init
const listEntitiesDetectionJobs = yield* AWS.Comprehend.ListEntitiesDetectionJobs();

// runtime
const page = yield* listEntitiesDetectionJobs({
  Filter: { JobStatus: "IN_PROGRESS" },
  MaxResults: 25,
});
// page.EntitiesDetectionJobPropertiesList
```

@binding

## ListEventsDetectionJobs

Runtime binding for `comprehend:ListEventsDetectionJobs` — list the account's
asynchronous event detection jobs, with optional status/name/time filters.

The binding takes no arguments and grants the action on `*` (job APIs
have no resource-level IAM).

### Monitoring Analysis Jobs
**Example:** List Recent EventsDetection Jobs
```typescript
// init
const listEventsDetectionJobs = yield* AWS.Comprehend.ListEventsDetectionJobs();

// runtime
const page = yield* listEventsDetectionJobs({
  Filter: { JobStatus: "IN_PROGRESS" },
  MaxResults: 25,
});
// page.EventsDetectionJobPropertiesList
```

@binding

## ListKeyPhrasesDetectionJobs

Runtime binding for `comprehend:ListKeyPhrasesDetectionJobs` — list the account's
asynchronous key-phrase detection jobs, with optional status/name/time filters.

The binding takes no arguments and grants the action on `*` (job APIs
have no resource-level IAM).

### Monitoring Analysis Jobs
**Example:** List Recent KeyPhrasesDetection Jobs
```typescript
// init
const listKeyPhrasesDetectionJobs = yield* AWS.Comprehend.ListKeyPhrasesDetectionJobs();

// runtime
const page = yield* listKeyPhrasesDetectionJobs({
  Filter: { JobStatus: "IN_PROGRESS" },
  MaxResults: 25,
});
// page.KeyPhrasesDetectionJobPropertiesList
```

@binding

## ListPiiEntitiesDetectionJobs

Runtime binding for `comprehend:ListPiiEntitiesDetectionJobs` — list the account's
asynchronous PII entity detection jobs, with optional status/name/time filters.

The binding takes no arguments and grants the action on `*` (job APIs
have no resource-level IAM).

### Monitoring Analysis Jobs
**Example:** List Recent PiiEntitiesDetection Jobs
```typescript
// init
const listPiiEntitiesDetectionJobs = yield* AWS.Comprehend.ListPiiEntitiesDetectionJobs();

// runtime
const page = yield* listPiiEntitiesDetectionJobs({
  Filter: { JobStatus: "IN_PROGRESS" },
  MaxResults: 25,
});
// page.PiiEntitiesDetectionJobPropertiesList
```

@binding

## ListSentimentDetectionJobs

Runtime binding for `comprehend:ListSentimentDetectionJobs` — list the account's
asynchronous sentiment detection jobs, with optional status/name/time filters.

The binding takes no arguments and grants the action on `*` (job APIs
have no resource-level IAM).

### Monitoring Analysis Jobs
**Example:** List Recent SentimentDetection Jobs
```typescript
// init
const listSentimentDetectionJobs = yield* AWS.Comprehend.ListSentimentDetectionJobs();

// runtime
const page = yield* listSentimentDetectionJobs({
  Filter: { JobStatus: "IN_PROGRESS" },
  MaxResults: 25,
});
// page.SentimentDetectionJobPropertiesList
```

@binding

## ListTargetedSentimentDetectionJobs

Runtime binding for `comprehend:ListTargetedSentimentDetectionJobs` — list the account's
asynchronous targeted-sentiment detection jobs, with optional status/name/time filters.

The binding takes no arguments and grants the action on `*` (job APIs
have no resource-level IAM).

### Monitoring Analysis Jobs
**Example:** List Recent TargetedSentimentDetection Jobs
```typescript
// init
const listTargetedSentimentDetectionJobs = yield* AWS.Comprehend.ListTargetedSentimentDetectionJobs();

// runtime
const page = yield* listTargetedSentimentDetectionJobs({
  Filter: { JobStatus: "IN_PROGRESS" },
  MaxResults: 25,
});
// page.TargetedSentimentDetectionJobPropertiesList
```

@binding

## ListTopicsDetectionJobs

Runtime binding for `comprehend:ListTopicsDetectionJobs` — list the account's
asynchronous topic modeling jobs, with optional status/name/time filters.

The binding takes no arguments and grants the action on `*` (job APIs
have no resource-level IAM).

### Monitoring Analysis Jobs
**Example:** List Recent TopicsDetection Jobs
```typescript
// init
const listTopicsDetectionJobs = yield* AWS.Comprehend.ListTopicsDetectionJobs();

// runtime
const page = yield* listTopicsDetectionJobs({
  Filter: { JobStatus: "IN_PROGRESS" },
  MaxResults: 25,
});
// page.TopicsDetectionJobPropertiesList
```

@binding

## StopDominantLanguageDetectionJob

Runtime binding for `comprehend:StopDominantLanguageDetectionJob` — request termination
of an in-progress asynchronous dominant-language detection job. The job moves to
`STOP_REQUESTED` and then `STOPPED`; documents already processed are
written to the output location.

The binding takes no arguments and grants the action on `*` (job APIs
have no resource-level IAM).

### Stopping Analysis Jobs
**Example:** Stop a Running DominantLanguageDetection Job
```typescript
// init
const stopDominantLanguageDetectionJob = yield* AWS.Comprehend.StopDominantLanguageDetectionJob();

// runtime
const result = yield* stopDominantLanguageDetectionJob({ JobId: jobId });
// result.JobStatus === "STOP_REQUESTED"
```

@binding

## StopEntitiesDetectionJob

Runtime binding for `comprehend:StopEntitiesDetectionJob` — request termination
of an in-progress asynchronous entity detection job. The job moves to
`STOP_REQUESTED` and then `STOPPED`; documents already processed are
written to the output location.

The binding takes no arguments and grants the action on `*` (job APIs
have no resource-level IAM).

### Stopping Analysis Jobs
**Example:** Stop a Running EntitiesDetection Job
```typescript
// init
const stopEntitiesDetectionJob = yield* AWS.Comprehend.StopEntitiesDetectionJob();

// runtime
const result = yield* stopEntitiesDetectionJob({ JobId: jobId });
// result.JobStatus === "STOP_REQUESTED"
```

@binding

## StopEventsDetectionJob

Runtime binding for `comprehend:StopEventsDetectionJob` — request termination
of an in-progress asynchronous event detection job. The job moves to
`STOP_REQUESTED` and then `STOPPED`; documents already processed are
written to the output location.

The binding takes no arguments and grants the action on `*` (job APIs
have no resource-level IAM).

### Stopping Analysis Jobs
**Example:** Stop a Running EventsDetection Job
```typescript
// init
const stopEventsDetectionJob = yield* AWS.Comprehend.StopEventsDetectionJob();

// runtime
const result = yield* stopEventsDetectionJob({ JobId: jobId });
// result.JobStatus === "STOP_REQUESTED"
```

@binding

## StopKeyPhrasesDetectionJob

Runtime binding for `comprehend:StopKeyPhrasesDetectionJob` — request termination
of an in-progress asynchronous key-phrase detection job. The job moves to
`STOP_REQUESTED` and then `STOPPED`; documents already processed are
written to the output location.

The binding takes no arguments and grants the action on `*` (job APIs
have no resource-level IAM).

### Stopping Analysis Jobs
**Example:** Stop a Running KeyPhrasesDetection Job
```typescript
// init
const stopKeyPhrasesDetectionJob = yield* AWS.Comprehend.StopKeyPhrasesDetectionJob();

// runtime
const result = yield* stopKeyPhrasesDetectionJob({ JobId: jobId });
// result.JobStatus === "STOP_REQUESTED"
```

@binding

## StopPiiEntitiesDetectionJob

Runtime binding for `comprehend:StopPiiEntitiesDetectionJob` — request termination
of an in-progress asynchronous PII entity detection job. The job moves to
`STOP_REQUESTED` and then `STOPPED`; documents already processed are
written to the output location.

The binding takes no arguments and grants the action on `*` (job APIs
have no resource-level IAM).

### Stopping Analysis Jobs
**Example:** Stop a Running PiiEntitiesDetection Job
```typescript
// init
const stopPiiEntitiesDetectionJob = yield* AWS.Comprehend.StopPiiEntitiesDetectionJob();

// runtime
const result = yield* stopPiiEntitiesDetectionJob({ JobId: jobId });
// result.JobStatus === "STOP_REQUESTED"
```

@binding

## StopSentimentDetectionJob

Runtime binding for `comprehend:StopSentimentDetectionJob` — request termination
of an in-progress asynchronous sentiment detection job. The job moves to
`STOP_REQUESTED` and then `STOPPED`; documents already processed are
written to the output location.

The binding takes no arguments and grants the action on `*` (job APIs
have no resource-level IAM).

### Stopping Analysis Jobs
**Example:** Stop a Running SentimentDetection Job
```typescript
// init
const stopSentimentDetectionJob = yield* AWS.Comprehend.StopSentimentDetectionJob();

// runtime
const result = yield* stopSentimentDetectionJob({ JobId: jobId });
// result.JobStatus === "STOP_REQUESTED"
```

@binding

## StopTargetedSentimentDetectionJob

Runtime binding for `comprehend:StopTargetedSentimentDetectionJob` — request termination
of an in-progress asynchronous targeted-sentiment detection job. The job moves to
`STOP_REQUESTED` and then `STOPPED`; documents already processed are
written to the output location.

The binding takes no arguments and grants the action on `*` (job APIs
have no resource-level IAM).

### Stopping Analysis Jobs
**Example:** Stop a Running TargetedSentimentDetection Job
```typescript
// init
const stopTargetedSentimentDetectionJob = yield* AWS.Comprehend.StopTargetedSentimentDetectionJob();

// runtime
const result = yield* stopTargetedSentimentDetectionJob({ JobId: jobId });
// result.JobStatus === "STOP_REQUESTED"
```

@binding
