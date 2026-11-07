<!-- Docs for the generated AWS.MailManager bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## CreateAddressListImportJob

Runtime binding for `ses:CreateAddressListImportJob`.

Creates a bulk import job against the bound address list, returning
the job id and a pre-signed URL to upload the address data (CSV or
JSON). The address list id is injected from the binding. Provide the implementation with
`Effect.provide(AWS.MailManager.CreateAddressListImportJobHttp)`.
### Bulk Importing Members
**Example:** Create an Import Job
```typescript
const createImportJob = yield* MailManager.CreateAddressListImportJob(blockList);

// runtime
const { JobId, PreSignedUrl } = yield* createImportJob({
  Name: "nightly-sync",
  ImportDataFormat: { ImportDataType: "CSV" },
});
// upload the CSV to PreSignedUrl, then start the job
```

@binding

## DeregisterMemberFromAddressList

Runtime binding for `ses:DeregisterMemberFromAddressList`.

Removes an email address from the bound address list. The address
list id is injected from the binding. Provide the implementation with
`Effect.provide(AWS.MailManager.DeregisterMemberFromAddressListHttp)`.
### Managing Address List Members
**Example:** Unblock a Sender
```typescript
const deregisterMember = yield* MailManager.DeregisterMemberFromAddressList(blockList);

// runtime
yield* deregisterMember({ Address: "reformed@example.com" });
```

@binding

## GetAddressListImportJob

Runtime binding for `ses:GetAddressListImportJob`.

Fetches the detail and status of an import job created against the
bound address list (by `JobId`). IAM access is granted on the bound
list's ARN. Provide the implementation with
`Effect.provide(AWS.MailManager.GetAddressListImportJobHttp)`.
### Bulk Importing Members
**Example:** Poll an Import Job
```typescript
const getImportJob = yield* MailManager.GetAddressListImportJob(blockList);

// runtime
const job = yield* getImportJob({ JobId });
if (job.Status === "COMPLETED") {
  yield* Effect.log(`imported ${job.ImportedItemsCount} addresses`);
}
```

@binding

## GetArchiveExport

Runtime binding for `ses:GetArchiveExport`.

Fetches the parameters and status of an archive export (by
`ExportId`). IAM access is granted on the bound archive's ARN. Provide the implementation with
`Effect.provide(AWS.MailManager.GetArchiveExportHttp)`.
### Exporting from the Archive
**Example:** Poll an Export
```typescript
const getExport = yield* MailManager.GetArchiveExport(archive);

// runtime
const status = yield* getExport({ ExportId });
```

@binding

## GetArchiveMessage

Runtime binding for `ses:GetArchiveMessage`.

Fetches a pre-signed download link, envelope, and ingress metadata
for one archived message (by `ArchivedMessageId` from a search
result). IAM access is granted on the bound archive's ARN. Provide the implementation with
`Effect.provide(AWS.MailManager.GetArchiveMessageHttp)`.
### Reading Archived Messages
**Example:** Download an Archived Message
```typescript
const getMessage = yield* MailManager.GetArchiveMessage(archive);

// runtime
const { MessageDownloadLink, Envelope } = yield* getMessage({ ArchivedMessageId });
```

@binding

## GetArchiveMessageContent

Runtime binding for `ses:GetArchiveMessageContent`.

Fetches the parsed text/HTML body of one archived message (by
`ArchivedMessageId` from a search result). IAM access is granted on
the bound archive's ARN. Provide the implementation with
`Effect.provide(AWS.MailManager.GetArchiveMessageContentHttp)`.
### Reading Archived Messages
**Example:** Read a Message Body
```typescript
const getMessageContent = yield* MailManager.GetArchiveMessageContent(archive);

// runtime
const { Body } = yield* getMessageContent({ ArchivedMessageId });
yield* Effect.log(Body?.Text ?? Body?.Html ?? "(malformed)");
```

@binding

## GetArchiveSearch

Runtime binding for `ses:GetArchiveSearch`.

Fetches the parameters and status of an archive search (by
`SearchId`). IAM access is granted on the bound archive's ARN. Provide the implementation with
`Effect.provide(AWS.MailManager.GetArchiveSearchHttp)`.
### Searching the Archive
**Example:** Poll a Search Until It Completes
```typescript
const getSearch = yield* MailManager.GetArchiveSearch(archive);

// runtime
const search = yield* getSearch({ SearchId }).pipe(
  Effect.repeat({
    schedule: Schedule.spaced("2 seconds"),
    until: (s) => s.Status?.State === "COMPLETED" || s.Status?.State === "FAILED",
    times: 30,
  }),
);
```

@binding

## GetArchiveSearchResults

Runtime binding for `ses:GetArchiveSearchResults`.

Fetches the result rows of a completed archive search (by
`SearchId`): sender, subject, envelope, and the `ArchivedMessageId`
used to download each message. IAM access is granted on the bound
archive's ARN. Provide the implementation with
`Effect.provide(AWS.MailManager.GetArchiveSearchResultsHttp)`.
### Searching the Archive
**Example:** Read Search Results
```typescript
const getSearchResults = yield* MailManager.GetArchiveSearchResults(archive);

// runtime
const { Rows } = yield* getSearchResults({ SearchId });
```

@binding

## GetMemberOfAddressList

Runtime binding for `ses:GetMemberOfAddressList`.

Fetches a single member of the bound address list (address +
registration timestamp), failing with `ResourceNotFoundException` when
the address is not on the list. The address list id is injected from
the binding. Provide the implementation with
`Effect.provide(AWS.MailManager.GetMemberOfAddressListHttp)`.
### Managing Address List Members
**Example:** Check Whether a Sender Is Blocked
```typescript
const getMember = yield* MailManager.GetMemberOfAddressList(blockList);

// runtime
const blocked = yield* getMember({ Address: sender }).pipe(
  Effect.map(() => true),
  Effect.catchTag("ResourceNotFoundException", () => Effect.succeed(false)),
);
```

@binding

## ListAddressListImportJobs

Runtime binding for `ses:ListAddressListImportJobs`.

Lists the import jobs created against the bound address list. The
address list id is injected from the binding. Provide the implementation with
`Effect.provide(AWS.MailManager.ListAddressListImportJobsHttp)`.
### Bulk Importing Members
**Example:** List Import Jobs
```typescript
const listImportJobs = yield* MailManager.ListAddressListImportJobs(blockList);

// runtime
const { ImportJobs } = yield* listImportJobs({});
```

@binding

## ListArchiveExports

Runtime binding for `ses:ListArchiveExports`.

Lists the recent exports of the bound archive. The archive id is
injected from the binding. Provide the implementation with
`Effect.provide(AWS.MailManager.ListArchiveExportsHttp)`.
### Exporting from the Archive
**Example:** List Recent Exports
```typescript
const listExports = yield* MailManager.ListArchiveExports(archive);

// runtime
const { Exports } = yield* listExports({});
```

@binding

## ListArchiveSearches

Runtime binding for `ses:ListArchiveSearches`.

Lists the recent searches of the bound archive. The archive id is
injected from the binding. Provide the implementation with
`Effect.provide(AWS.MailManager.ListArchiveSearchesHttp)`.
### Searching the Archive
**Example:** List Recent Searches
```typescript
const listSearches = yield* MailManager.ListArchiveSearches(archive);

// runtime
const { Searches } = yield* listSearches({});
```

@binding

## ListMembersOfAddressList

Runtime binding for `ses:ListMembersOfAddressList`.

Lists the members of the bound address list, optionally filtered by
address prefix. The address list id is injected from the binding. Provide the implementation with
`Effect.provide(AWS.MailManager.ListMembersOfAddressListHttp)`.
### Managing Address List Members
**Example:** Enumerate the Block List
```typescript
const listMembers = yield* MailManager.ListMembersOfAddressList(blockList);

// runtime
const { Addresses } = yield* listMembers({});
```

@binding

## RegisterMemberToAddressList

Runtime binding for `ses:RegisterMemberToAddressList`.

Adds an email address to the bound address list. The address list id
is injected from the binding. Registering an already-present address
succeeds (idempotent upsert). Provide the implementation with
`Effect.provide(AWS.MailManager.RegisterMemberToAddressListHttp)`.
### Managing Address List Members
**Example:** Block a Sender
```typescript
// init — bind the operation to the address list
const registerMember = yield* MailManager.RegisterMemberToAddressList(blockList);

// runtime
yield* registerMember({ Address: "spammer@example.com" });
```

@binding

## StartAddressListImportJob

Runtime binding for `ses:StartAddressListImportJob`.

Starts a created import job once its address data has been uploaded
to the pre-signed URL. IAM access is granted on the bound list's ARN. Provide the implementation with
`Effect.provide(AWS.MailManager.StartAddressListImportJobHttp)`.
### Bulk Importing Members
**Example:** Start an Import Job
```typescript
const startImportJob = yield* MailManager.StartAddressListImportJob(blockList);

// runtime
yield* startImportJob({ JobId });
```

@binding

## StartArchiveExport

Runtime binding for `ses:StartArchiveExport`.

Starts an asynchronous export of messages from the bound archive to
an S3 bucket, returning an `ExportId` to poll. The archive id is
injected from the binding. The function also needs `s3:PutObject` on
the destination. Provide the implementation with
`Effect.provide(AWS.MailManager.StartArchiveExportHttp)`.
### Exporting from the Archive
**Example:** Export a Day of Mail to S3
```typescript
const startExport = yield* MailManager.StartArchiveExport(archive);

// runtime
const { ExportId } = yield* startExport({
  FromTimestamp: new Date(Date.now() - 86_400_000),
  ToTimestamp: new Date(),
  ExportDestinationConfiguration: {
    S3: { S3Location: "s3://my-export-bucket/mail/" },
  },
});
```

@binding

## StartArchiveSearch

Runtime binding for `ses:StartArchiveSearch`.

Starts an asynchronous search of the bound archive over a time window
with optional filters, returning a `SearchId` to poll. The archive id
is injected from the binding. Provide the implementation with
`Effect.provide(AWS.MailManager.StartArchiveSearchHttp)`.
### Searching the Archive
**Example:** Search the Last 24 Hours
```typescript
const startSearch = yield* MailManager.StartArchiveSearch(archive);

// runtime
const { SearchId } = yield* startSearch({
  FromTimestamp: new Date(Date.now() - 86_400_000),
  ToTimestamp: new Date(),
  MaxResults: 100,
});
```

@binding

## StopAddressListImportJob

Runtime binding for `ses:StopAddressListImportJob`.

Stops an in-flight import job. Addresses already imported remain on
the list. IAM access is granted on the bound list's ARN. Provide the implementation with
`Effect.provide(AWS.MailManager.StopAddressListImportJobHttp)`.
### Bulk Importing Members
**Example:** Stop an Import Job
```typescript
const stopImportJob = yield* MailManager.StopAddressListImportJob(blockList);

// runtime
yield* stopImportJob({ JobId });
```

@binding

## StopArchiveExport

Runtime binding for `ses:StopArchiveExport`.

Cancels a queued or running archive export (by `ExportId`). IAM
access is granted on the bound archive's ARN. Provide the implementation with
`Effect.provide(AWS.MailManager.StopArchiveExportHttp)`.
### Exporting from the Archive
**Example:** Cancel an Export
```typescript
const stopExport = yield* MailManager.StopArchiveExport(archive);

// runtime
yield* stopExport({ ExportId });
```

@binding

## StopArchiveSearch

Runtime binding for `ses:StopArchiveSearch`.

Cancels a queued or running archive search (by `SearchId`). IAM
access is granted on the bound archive's ARN. Provide the implementation with
`Effect.provide(AWS.MailManager.StopArchiveSearchHttp)`.
### Searching the Archive
**Example:** Cancel a Search
```typescript
const stopSearch = yield* MailManager.StopArchiveSearch(archive);

// runtime
yield* stopSearch({ SearchId });
```

@binding
