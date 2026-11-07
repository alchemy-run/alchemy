<!-- Docs for the generated AWS.Glacier bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## AbortMultipartUpload

Runtime binding for the `AbortMultipartUpload` operation (IAM action
`glacier:AbortMultipartUpload` on the vault ARN).

Aborts an in-progress multipart upload on the bound {@link Vault},
freeing its uploaded parts. Aborting an already-aborted or completed
upload fails with the typed `ResourceNotFoundException`.
Provide the implementation with
`Effect.provide(AWS.Glacier.AbortMultipartUploadHttp)`.
### Uploading Archives
**Example:** Abort an in-progress upload
```typescript
const abortMultipartUpload = yield* AWS.Glacier.AbortMultipartUpload(vault);

yield* abortMultipartUpload({ uploadId });
```

@binding

## AbortMultipartUpload.Request

`AbortMultipartUpload` request with `accountId` and `vaultName` injected from the bound
{@link Vault}.

## CompleteMultipartUpload

Runtime binding for the `CompleteMultipartUpload` operation (IAM action
`glacier:CompleteMultipartUpload` on the vault ARN).

Assembles the uploaded parts of a multipart upload into an archive in
the bound {@link Vault}. `archiveSize` is the total size in bytes (as a
string) and `checksum` the SHA-256 tree hash of the whole archive; the
response carries the new `archiveId`.
Provide the implementation with
`Effect.provide(AWS.Glacier.CompleteMultipartUploadHttp)`.
### Uploading Archives
**Example:** Complete a multipart upload
```typescript
const completeMultipartUpload =
  yield* AWS.Glacier.CompleteMultipartUpload(vault);

const { archiveId } = yield* completeMultipartUpload({
  uploadId,
  archiveSize: String(totalSize),
  checksum: treeHash,
});
```

@binding

## CompleteMultipartUpload.Request

`CompleteMultipartUpload` request with `accountId` and `vaultName` injected from the bound
{@link Vault}.

## DeleteArchive

Runtime binding for the `DeleteArchive` operation (IAM action
`glacier:DeleteArchive` on the vault ARN).

Deletes an archive from the bound {@link Vault}. The operation is
idempotent — deleting an already-deleted archive is not an error.
Provide the implementation with
`Effect.provide(AWS.Glacier.DeleteArchiveHttp)`.
### Deleting Archives
**Example:** Delete an archive by ID
```typescript
const deleteArchive = yield* AWS.Glacier.DeleteArchive(vault);

yield* deleteArchive({ archiveId });
```

@binding

## DeleteArchive.Request

`DeleteArchive` request with `accountId` and `vaultName` injected from the bound
{@link Vault}.

## DescribeJob

Runtime binding for the `DescribeJob` operation (IAM action
`glacier:DescribeJob` on the vault ARN).

Reads the status of a job previously started with {@link InitiateJob} on
the bound {@link Vault} — its action, status code, and completion flag.
Provide the implementation with
`Effect.provide(AWS.Glacier.DescribeJobHttp)`.
### Retrieving Archives
**Example:** Poll a retrieval job
```typescript
const describeJob = yield* AWS.Glacier.DescribeJob(vault);

const job = yield* describeJob({ jobId });
if (job.Completed) {
  // fetch with GetJobOutput
}
```

@binding

## DescribeJob.Request

`DescribeJob` request with `accountId` and `vaultName` injected from the bound
{@link Vault}.

## DescribeVault

Runtime binding for the `DescribeVault` operation (IAM action
`glacier:DescribeVault` on the vault ARN).

Reads the bound {@link Vault}'s description — archive count, total size
in bytes, and last inventory date (both as of the last nightly
inventory).
Provide the implementation with
`Effect.provide(AWS.Glacier.DescribeVaultHttp)`.
### Inspecting Vaults
**Example:** Read the vault's stats
```typescript
const describeVault = yield* AWS.Glacier.DescribeVault(vault);

const { NumberOfArchives, SizeInBytes } = yield* describeVault();
```

@binding

## GetJobOutput

Runtime binding for the `GetJobOutput` operation (IAM action
`glacier:GetJobOutput` on the vault ARN).

Downloads the output of a completed job on the bound {@link Vault} — the
archive bytes for an archive-retrieval job, or the JSON inventory for an
inventory-retrieval job. Supports ranged reads via the `range` header
field for chunked downloads.
Provide the implementation with
`Effect.provide(AWS.Glacier.GetJobOutputHttp)`.
### Retrieving Archives
**Example:** Download a completed job's output
```typescript
const getJobOutput = yield* AWS.Glacier.GetJobOutput(vault);

const { body, status } = yield* getJobOutput({ jobId });
```

@binding

## GetJobOutput.Request

`GetJobOutput` request with `accountId` and `vaultName` injected from the bound
{@link Vault}.

## InitiateJob

Runtime binding for the `InitiateJob` operation (IAM action
`glacier:InitiateJob` on the vault ARN).

Initiates an archive-retrieval, inventory-retrieval, or select job
against the bound {@link Vault}. Retrieval is asynchronous — poll the
returned `jobId` with {@link DescribeJob} and fetch the result with
{@link GetJobOutput} once it completes (typically 3–5 hours for standard
tier, minutes for expedited).
Provide the implementation with
`Effect.provide(AWS.Glacier.InitiateJobHttp)`.
### Retrieving Archives
**Example:** Start an inventory-retrieval job
```typescript
const initiateJob = yield* AWS.Glacier.InitiateJob(vault);

const { jobId } = yield* initiateJob({
  jobParameters: { Type: "inventory-retrieval" },
});
```

@binding

## InitiateJob.Request

`InitiateJob` request with `accountId` and `vaultName` injected from the bound
{@link Vault}.

## InitiateMultipartUpload

Runtime binding for the `InitiateMultipartUpload` operation (IAM action
`glacier:InitiateMultipartUpload` on the vault ARN).

Starts a multipart upload to the bound {@link Vault} and returns the
`uploadId` to use with {@link UploadMultipartPart} and
{@link CompleteMultipartUpload}. `partSize` must be a power-of-two
multiple of 1 MiB (as a string of bytes).
Provide the implementation with
`Effect.provide(AWS.Glacier.InitiateMultipartUploadHttp)`.
### Uploading Archives
**Example:** Start a multipart upload
```typescript
const initiateMultipartUpload =
  yield* AWS.Glacier.InitiateMultipartUpload(vault);

const { uploadId } = yield* initiateMultipartUpload({
  archiveDescription: "large backup",
  partSize: String(8 * 1024 * 1024),
});
```

@binding

## InitiateMultipartUpload.Request

`InitiateMultipartUpload` request with `accountId` and `vaultName` injected from the bound
{@link Vault}.

## ListJobs

Runtime binding for the `ListJobs` operation (IAM action
`glacier:ListJobs` on the vault ARN).

Lists in-progress and recently finished jobs for the bound
{@link Vault}, optionally filtered by status code or completion.
Provide the implementation with
`Effect.provide(AWS.Glacier.ListJobsHttp)`.
### Retrieving Archives
**Example:** List the vault's jobs
```typescript
const listJobs = yield* AWS.Glacier.ListJobs(vault);

const { JobList } = yield* listJobs({ completed: "true" });
```

@binding

## ListJobs.Request

`ListJobs` request with `accountId` and `vaultName` injected from the bound
{@link Vault}.

## ListMultipartUploads

Runtime binding for the `ListMultipartUploads` operation (IAM action
`glacier:ListMultipartUploads` on the vault ARN).

Lists the in-progress multipart uploads for the bound {@link Vault} —
useful for finding and aborting stale uploads that still accrue
storage.
Provide the implementation with
`Effect.provide(AWS.Glacier.ListMultipartUploadsHttp)`.
### Uploading Archives
**Example:** List in-progress uploads
```typescript
const listMultipartUploads =
  yield* AWS.Glacier.ListMultipartUploads(vault);

const { UploadsList } = yield* listMultipartUploads();
```

@binding

## ListMultipartUploads.Request

`ListMultipartUploads` request with `accountId` and `vaultName` injected from the bound
{@link Vault}.

## ListParts

Runtime binding for the `ListParts` operation (IAM action
`glacier:ListParts` on the vault ARN).

Lists the parts already uploaded for an in-progress multipart upload on
the bound {@link Vault}, sorted by byte range — the resume point after a
crashed uploader.
Provide the implementation with
`Effect.provide(AWS.Glacier.ListPartsHttp)`.
### Uploading Archives
**Example:** List a multipart upload's parts
```typescript
const listParts = yield* AWS.Glacier.ListParts(vault);

const { Parts } = yield* listParts({ uploadId });
```

@binding

## ListParts.Request

`ListParts` request with `accountId` and `vaultName` injected from the bound
{@link Vault}.

## UploadArchive

Runtime binding for the `UploadArchive` operation (IAM action
`glacier:UploadArchive` on the vault ARN).

Uploads an archive to the bound {@link Vault} in a single request (up to
4 GiB; use the multipart bindings for larger archives). The response
carries the new `archiveId` — Glacier has no list-archives API outside of
inventory jobs, so persist it.
Provide the implementation with
`Effect.provide(AWS.Glacier.UploadArchiveHttp)`.
### Uploading Archives
**Example:** Upload a small archive
```typescript
const uploadArchive = yield* AWS.Glacier.UploadArchive(vault);

const { archiveId, checksum } = yield* uploadArchive({
  archiveDescription: "nightly backup",
  checksum: treeHash,
  body: payload,
});
```

@binding

## UploadArchive.Request

`UploadArchive` request with `accountId` and `vaultName` injected from the bound
{@link Vault}.

## UploadMultipartPart

Runtime binding for the `UploadMultipartPart` operation (IAM action
`glacier:UploadMultipartPart` on the vault ARN).

Uploads one part of a multipart upload to the bound {@link Vault}. The
`range` field carries the part's byte range (e.g.
`bytes 0-8388607/*`) and `checksum` its SHA-256 tree hash.
Provide the implementation with
`Effect.provide(AWS.Glacier.UploadMultipartPartHttp)`.
### Uploading Archives
**Example:** Upload one part
```typescript
const uploadMultipartPart = yield* AWS.Glacier.UploadMultipartPart(vault);

yield* uploadMultipartPart({
  uploadId,
  range: "bytes 0-8388607/*",
  checksum: partTreeHash,
  body: partBytes,
});
```

@binding

## UploadMultipartPart.Request

`UploadMultipartPart` request with `accountId` and `vaultName` injected from the bound
{@link Vault}.
