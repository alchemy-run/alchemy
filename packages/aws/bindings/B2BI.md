<!-- Docs for the generated AWS.B2BI bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## CreateStarterMappingTemplate

Runtime binding for `b2bi:CreateStarterMappingTemplate`.

Generates a starter mapping template (JSONATA or XSLT) for a given X12
transaction set — a scaffold covering every field of the transaction that
can be edited down to the desired mapping. Optionally writes the template
to S3 via `outputSampleLocation`. Provide the implementation with
`Effect.provide(AWS.B2BI.CreateStarterMappingTemplateHttp)`.
### Generating Mappings
**Example:** Scaffold a JSONATA Template for X12 850
```typescript
// init — account-level, no resource argument
const createStarterMappingTemplate =
  yield* AWS.B2BI.CreateStarterMappingTemplate();

// runtime
const result = yield* createStarterMappingTemplate({
  mappingType: "JSONATA",
  templateDetails: {
    x12: { transactionSet: "X12_850", version: "VERSION_4010" },
  },
});
// result.mappingTemplate — the generated starter template
```

@binding

## GenerateMapping

Runtime binding for `b2bi:GenerateMapping`.

Generates a mapping template (JSONATA or XSLT) from a sample input and
desired output document using AI-assisted mapping — useful for building
self-service EDI onboarding flows where trading partners supply sample
documents. `mappingAccuracy` reports the model's confidence. Provide the
implementation with `Effect.provide(AWS.B2BI.GenerateMappingHttp)`.
### Generating Mappings
**Example:** Generate a JSONATA Template from Samples
```typescript
// init — account-level, no resource argument
const generateMapping = yield* AWS.B2BI.GenerateMapping();

// runtime
const result = yield* generateMapping({
  inputFileContent: JSON.stringify({ customer: "acme" }),
  outputFileContent: JSON.stringify({ name: "acme" }),
  mappingType: "JSONATA",
});
// result.mappingTemplate, result.mappingAccuracy
```

@binding

## GetTransformerJob

Runtime binding for `b2bi:GetTransformerJob`.

Polls the status of an asynchronous transformer job started with
{@link StartTransformerJob} — `status` progresses from `running` to
`succeeded` (with `outputFiles`) or `failed` (with `message`). Provide the
implementation with `Effect.provide(AWS.B2BI.GetTransformerJobHttp)`.
### Running Transformer Jobs
**Example:** Poll a Transformer Job Until It Finishes
```typescript
// init — grants b2bi:GetTransformerJob on the transformer
const getTransformerJob = yield* AWS.B2BI.GetTransformerJob(transformer);

// runtime
const job = yield* getTransformerJob({ transformerJobId }).pipe(
  Effect.repeat({
    schedule: Schedule.spaced("2 seconds"),
    until: (job) => job.status !== "running",
    times: 30,
  }),
);
```

@binding

## StartTransformerJob

Runtime binding for `b2bi:StartTransformerJob`.

Runs an asynchronous transformer job against an EDI document in S3 — the
bound {@link Transformer} (which must be `active`) parses and maps the
`inputFile` and writes the result to `outputLocation`. Poll the returned
`transformerJobId` with {@link GetTransformerJob}. B2BI accesses the S3
locations with its service principal, so the buckets need a bucket policy
granting `b2bi.amazonaws.com` read/write access. Provide the
implementation with `Effect.provide(AWS.B2BI.StartTransformerJobHttp)`.
### Running Transformer Jobs
**Example:** Transform an EDI Document in S3
```typescript
// init — grants b2bi:StartTransformerJob on the transformer
const startTransformerJob = yield* AWS.B2BI.StartTransformerJob(transformer);

// runtime
const { transformerJobId } = yield* startTransformerJob({
  inputFile: { bucketName: "my-edi-bucket", key: "inbound/order.edi" },
  outputLocation: { bucketName: "my-edi-bucket", key: "output/" },
});
```

@binding

## TestConversion

Runtime binding for `b2bi:TestConversion`.

Synchronously converts an inline JSON or XML document into an outbound
X12 EDI document — the inline counterpart of an outbound transformer's
conversion step. Provide the implementation with
`Effect.provide(AWS.B2BI.TestConversionHttp)`.
### Converting Documents to EDI
**Example:** Convert JSON to an X12 850
```typescript
// init — account-level, no resource argument
const testConversion = yield* AWS.B2BI.TestConversion();

// runtime
const result = yield* testConversion({
  source: { fileFormat: "JSON", inputFile: { fileContent } },
  target: {
    fileFormat: "X12",
    formatDetails: {
      x12: { transactionSet: "X12_850", version: "VERSION_4010" },
    },
  },
});
// result.convertedFileContent — the generated X12 document
```

@binding

## TestMapping

Runtime binding for `b2bi:TestMapping`.

Synchronously maps sample content with a mapping template (JSONATA or
XSLT) — the inline counterpart of a transformer's mapping step, useful for
validating templates or transforming small documents on the fly without a
deployed transformer. Provide the implementation with
`Effect.provide(AWS.B2BI.TestMappingHttp)`.
### Testing Mappings
**Example:** Map a JSON Document with a JSONATA Template
```typescript
// init — account-level, no resource argument
const testMapping = yield* AWS.B2BI.TestMapping();

// runtime
const result = yield* testMapping({
  inputFileContent: JSON.stringify({ customer: "acme" }),
  mappingTemplate: '{ "name": customer }',
  fileFormat: "JSON",
});
// result.mappedFileContent === '{"name":"acme"}'
```

@binding

## TestParsing

Runtime binding for `b2bi:TestParsing`.

Synchronously parses an EDI document in S3 (e.g. an X12 file) into the
JSON or XML representation B2BI's mapping step consumes. B2BI reads the
`inputFile` with its service principal, so the bucket needs a bucket
policy granting `b2bi.amazonaws.com` read access. Provide the
implementation with `Effect.provide(AWS.B2BI.TestParsingHttp)`.
### Parsing EDI Documents
**Example:** Parse an X12 850 into JSON
```typescript
// init — account-level, no resource argument
const testParsing = yield* AWS.B2BI.TestParsing();

// runtime
const result = yield* testParsing({
  inputFile: { bucketName: "my-edi-bucket", key: "inbound/order.edi" },
  fileFormat: "JSON",
  ediType: {
    x12Details: { transactionSet: "X12_850", version: "VERSION_4010" },
  },
});
// result.parsedFileContent — the JSON representation of the EDI file
```

@binding
