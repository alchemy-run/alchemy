<!-- Docs for the generated AWS.Textract bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## AnalyzeDocument

Runtime binding for `textract:AnalyzeDocument` — synchronous analysis of
relationships in a document: forms (key-value pairs), tables, layout,
signatures, and natural-language queries. Pass the document as raw bytes
or as an S3 object reference; the caller needs `s3:GetObject` on the
bucket for S3 input (bind `AWS.S3.GetObject(bucket)` alongside).

### Synchronous Analysis
**Example:** Analyze Forms and Tables
```typescript
// init
const analyzeDocument = yield* AWS.Textract.AnalyzeDocument();

// runtime
const result = yield* analyzeDocument({
  Document: { Bytes: documentBytes },
  FeatureTypes: ["FORMS", "TABLES"],
});
const tables = (result.Blocks ?? []).filter((b) => b.BlockType === "TABLE");
```

@binding

## AnalyzeExpense

Runtime binding for `textract:AnalyzeExpense` — synchronous analysis of
invoices and receipts, extracting summary fields (vendor, total, dates)
and line-item groups.

### Synchronous Analysis
**Example:** Analyze an Invoice
```typescript
// init
const analyzeExpense = yield* AWS.Textract.AnalyzeExpense();

// runtime
const result = yield* analyzeExpense({
  Document: { Bytes: receiptBytes },
});
const fields = result.ExpenseDocuments?.[0]?.SummaryFields;
```

@binding

## AnalyzeID

Runtime binding for `textract:AnalyzeID` — synchronous extraction of
identity-document fields (name, date of birth, document number, …) from
images of passports, driver licenses, and other government IDs.

### Synchronous Analysis
**Example:** Analyze an Identity Document
```typescript
// init
const analyzeID = yield* AWS.Textract.AnalyzeID();

// runtime
const result = yield* analyzeID({
  DocumentPages: [{ Bytes: licenseBytes }],
});
const fields = result.IdentityDocuments?.[0]?.IdentityDocumentFields;
```

@binding

## DetectDocumentText

Runtime binding for `textract:DetectDocumentText` — synchronous OCR that
detects lines and words of text in a JPEG, PNG, PDF, or TIFF document.

Textract is a pure pay-per-call service with no resource to manage: the
binding takes no arguments and grants the function
`textract:DetectDocumentText` (the action has no resource-level IAM).
Pass the document as raw bytes (`Document.Bytes`) or as an S3 object
reference (`Document.S3Object`) — raw distilled types, no marshalling.

### Detecting Document Text
**Example:** Detect Text in Document Bytes
```typescript
// init
const detectDocumentText = yield* AWS.Textract.DetectDocumentText();

// runtime
const result = yield* detectDocumentText({
  Document: { Bytes: documentBytes },
});
const lines = (result.Blocks ?? [])
  .filter((block) => block.BlockType === "LINE")
  .map((block) => block.Text);
```

@binding

## GetDocumentAnalysis

Runtime binding for `textract:GetDocumentAnalysis` — read the status and
results of an asynchronous document-analysis job started with
`StartDocumentAnalysis`. Page through large result sets with `NextToken`.

### Asynchronous Document Analysis
**Example:** Poll an Analysis Job
```typescript
// init
const getDocumentAnalysis = yield* AWS.Textract.GetDocumentAnalysis();

// runtime
const result = yield* getDocumentAnalysis({ JobId: jobId });
if (result.JobStatus === "SUCCEEDED") {
  const blocks = result.Blocks;
}
```

@binding

## GetDocumentTextDetection

Runtime binding for `textract:GetDocumentTextDetection` — read the
status and results of an asynchronous OCR job started with
`StartDocumentTextDetection`.

### Asynchronous Text Detection
**Example:** Poll a Text Detection Job
```typescript
// init
const getDocumentTextDetection =
  yield* AWS.Textract.GetDocumentTextDetection();

// runtime
const result = yield* getDocumentTextDetection({ JobId: jobId });
const lines = (result.Blocks ?? [])
  .filter((b) => b.BlockType === "LINE")
  .map((b) => b.Text);
```

@binding

## GetExpenseAnalysis

Runtime binding for `textract:GetExpenseAnalysis` — read the status and
results of an asynchronous expense-analysis job started with
`StartExpenseAnalysis`.

### Asynchronous Expense Analysis
**Example:** Poll an Expense Analysis Job
```typescript
// init
const getExpenseAnalysis = yield* AWS.Textract.GetExpenseAnalysis();

// runtime
const result = yield* getExpenseAnalysis({ JobId: jobId });
const documents = result.ExpenseDocuments;
```

@binding

## GetLendingAnalysis

Runtime binding for `textract:GetLendingAnalysis` — read the status and
per-page extraction results of an asynchronous lending-analysis job
started with `StartLendingAnalysis`.

### Asynchronous Lending Analysis
**Example:** Poll a Lending Analysis Job
```typescript
// init
const getLendingAnalysis = yield* AWS.Textract.GetLendingAnalysis();

// runtime
const result = yield* getLendingAnalysis({ JobId: jobId });
const pages = result.Results;
```

@binding

## GetLendingAnalysisSummary

Runtime binding for `textract:GetLendingAnalysisSummary` — read the
document-group summary of an asynchronous lending-analysis job started
with `StartLendingAnalysis`.

### Asynchronous Lending Analysis
**Example:** Summarize a Lending Analysis Job
```typescript
// init
const getLendingAnalysisSummary =
  yield* AWS.Textract.GetLendingAnalysisSummary();

// runtime
const result = yield* getLendingAnalysisSummary({ JobId: jobId });
const groups = result.Summary?.DocumentGroups;
```

@binding

## ListAdapters

Runtime binding for `textract:ListAdapters` — list the Textract
adapters in the account/region.

### Managing Adapters
**Example:** List Adapters
```typescript
// init
const listAdapters = yield* AWS.Textract.ListAdapters();

// runtime
const result = yield* listAdapters();
const names = (result.Adapters ?? []).map((a) => a.AdapterName);
```

@binding

## StartDocumentAnalysis

Runtime binding for `textract:StartDocumentAnalysis` — start an
asynchronous analysis job for a (possibly multi-page) document stored in
S3. Poll the returned `JobId` with `GetDocumentAnalysis`, or pass a
`NotificationChannel` to receive the completion event on an SNS topic
(pair it with an SNS event source to invoke a Function on completion).
The caller needs `s3:GetObject` on the input bucket.

### Asynchronous Document Analysis
**Example:** Start an Analysis Job
```typescript
// init
const startDocumentAnalysis = yield* AWS.Textract.StartDocumentAnalysis();

// runtime
const { JobId } = yield* startDocumentAnalysis({
  DocumentLocation: { S3Object: { Bucket: bucketName, Name: "doc.pdf" } },
  FeatureTypes: ["TABLES"],
});
```

@binding

## StartDocumentTextDetection

Runtime binding for `textract:StartDocumentTextDetection` — start an
asynchronous OCR job for a (possibly multi-page) document stored in S3.
Poll the returned `JobId` with `GetDocumentTextDetection`. The caller
needs `s3:GetObject` on the input bucket.

### Asynchronous Text Detection
**Example:** Start a Text Detection Job
```typescript
// init
const startDocumentTextDetection =
  yield* AWS.Textract.StartDocumentTextDetection();

// runtime
const { JobId } = yield* startDocumentTextDetection({
  DocumentLocation: { S3Object: { Bucket: bucketName, Name: "doc.pdf" } },
});
```

@binding

## StartExpenseAnalysis

Runtime binding for `textract:StartExpenseAnalysis` — start an
asynchronous invoice/receipt analysis job for a document stored in S3.
Poll the returned `JobId` with `GetExpenseAnalysis`. The caller needs
`s3:GetObject` on the input bucket.

### Asynchronous Expense Analysis
**Example:** Start an Expense Analysis Job
```typescript
// init
const startExpenseAnalysis = yield* AWS.Textract.StartExpenseAnalysis();

// runtime
const { JobId } = yield* startExpenseAnalysis({
  DocumentLocation: { S3Object: { Bucket: bucketName, Name: "invoice.pdf" } },
});
```

@binding

## StartLendingAnalysis

Runtime binding for `textract:StartLendingAnalysis` — start an
asynchronous lending-document analysis job (classifies pages and routes
them to the right extraction model) for a document stored in S3. Poll
the returned `JobId` with `GetLendingAnalysis` /
`GetLendingAnalysisSummary`. The caller needs `s3:GetObject` on the
input bucket.

### Asynchronous Lending Analysis
**Example:** Start a Lending Analysis Job
```typescript
// init
const startLendingAnalysis = yield* AWS.Textract.StartLendingAnalysis();

// runtime
const { JobId } = yield* startLendingAnalysis({
  DocumentLocation: { S3Object: { Bucket: bucketName, Name: "loan.pdf" } },
});
```

@binding
