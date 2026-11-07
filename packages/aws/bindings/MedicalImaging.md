<!-- Docs for the generated AWS.MedicalImaging bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## CopyImageSet

Runtime binding for the `CopyImageSet` operation (IAM action
`medical-imaging:CopyImageSet`), scoped to one {@link Datastore}.

Copies an image set into a new one (omit `destinationImageSet`) or merges
it into an existing destination image set within the same data store.
Provide the implementation with
`Effect.provide(AWS.MedicalImaging.CopyImageSetHttp)`.

### Updating Image Sets
**Example:** Copy an Image Set
```typescript
const copyImageSet = yield* MedicalImaging.CopyImageSet(datastore);

const copy = yield* copyImageSet({
  sourceImageSetId,
  copyImageSetInformation: {
    sourceImageSet: { latestVersionId: "1" },
  },
});
// copy.destinationImageSetProperties.imageSetId
```

@binding

## CopyImageSet.Request

`CopyImageSet` request with `datastoreId` injected from the bound data
store.

## DeleteImageSet

Runtime binding for the `DeleteImageSet` operation (IAM action
`medical-imaging:DeleteImageSet`), scoped to one {@link Datastore}.

Deletes an image set (asynchronously — the response reports
`imageSetWorkflowStatus: "DELETING"`). A data store must contain no image
sets before it can be deleted. Provide the implementation with
`Effect.provide(AWS.MedicalImaging.DeleteImageSetHttp)`.

### Updating Image Sets
**Example:** Delete an Image Set
```typescript
const deleteImageSet = yield* MedicalImaging.DeleteImageSet(datastore);

const deleted = yield* deleteImageSet({ imageSetId });
// deleted.imageSetWorkflowStatus === "DELETING"
```

@binding

## DeleteImageSet.Request

`DeleteImageSet` request with `datastoreId` injected from the bound data
store.

## GetDICOMImportJob

Runtime binding for the `GetDICOMImportJob` operation (IAM action
`medical-imaging:GetDICOMImportJob`), scoped to one {@link Datastore}.

Reads the properties of a DICOM import job started with
{@link StartDICOMImportJob} — poll `jobProperties.jobStatus` until
`COMPLETED` (or `FAILED`), then review the output manifests at
`outputS3Uri` for per-object results. Provide the implementation with
`Effect.provide(AWS.MedicalImaging.GetDICOMImportJobHttp)`.

### Importing DICOM Data
**Example:** Poll an Import Job Until It Completes
```typescript
const getImportJob = yield* MedicalImaging.GetDICOMImportJob(datastore);

const job = yield* getImportJob({ jobId }).pipe(
  Effect.map((r) => r.jobProperties),
  Effect.repeat({
    schedule: Schedule.spaced("10 seconds"),
    until: (j) => j.jobStatus !== "SUBMITTED" && j.jobStatus !== "IN_PROGRESS",
    times: 30,
  }),
);
```

@binding

## GetDICOMImportJob.Request

`GetDICOMImportJob` request with `datastoreId` injected from the bound
data store.

## GetImageFrame

Runtime binding for the `GetImageFrame` operation (IAM action
`medical-imaging:GetImageFrame`), scoped to one {@link Datastore}.

Streams the pixel data of a single image frame (HTJ2K- or
JPEG2000-encoded, per the data store's `losslessStorageFormat`). Image
frame ids come from the image set metadata blob read with
{@link GetImageSetMetadata}. Provide the implementation with
`Effect.provide(AWS.MedicalImaging.GetImageFrameHttp)`.

### Reading Image Frames
**Example:** Fetch an Image Frame's Pixel Data
```typescript
const getImageFrame = yield* MedicalImaging.GetImageFrame(datastore);

const frame = yield* getImageFrame({
  imageSetId,
  imageFrameInformation: { imageFrameId },
});
// frame.imageFrameBlob (streaming body), frame.contentType
```

@binding

## GetImageFrame.Request

`GetImageFrame` request with `datastoreId` injected from the bound data
store.

## GetImageSet

Runtime binding for the `GetImageSet` operation (IAM action
`medical-imaging:GetImageSet`), scoped to one {@link Datastore}.

Reads an image set's properties — state, workflow status, version and
ARN. Pass `versionId` to read a specific version; omit it for the latest.
Provide the implementation with
`Effect.provide(AWS.MedicalImaging.GetImageSetHttp)`.

### Reading Image Sets
**Example:** Read Image Set Properties
```typescript
const getImageSet = yield* MedicalImaging.GetImageSet(datastore);

const imageSet = yield* getImageSet({ imageSetId });
// imageSet.imageSetState === "ACTIVE", imageSet.versionId, imageSet.imageSetArn
```

@binding

## GetImageSet.Request

`GetImageSet` request with `datastoreId` injected from the bound data
store.

## GetImageSetMetadata

Runtime binding for the `GetImageSetMetadata` operation (IAM action
`medical-imaging:GetImageSetMetadata`), scoped to one {@link Datastore}.

Streams the DICOM JSON metadata blob of an image set (gzip-encoded —
check `contentEncoding`). The metadata carries the patient/study/series
DICOM attributes plus the image frame ids used with {@link GetImageFrame}.
Provide the implementation with
`Effect.provide(AWS.MedicalImaging.GetImageSetMetadataHttp)`.

### Reading Image Sets
**Example:** Read Image Set Metadata
```typescript
const getMetadata = yield* MedicalImaging.GetImageSetMetadata(datastore);

const metadata = yield* getMetadata({ imageSetId });
// metadata.imageSetMetadataBlob (streaming body), metadata.contentEncoding === "gzip"
```

@binding

## GetImageSetMetadata.Request

`GetImageSetMetadata` request with `datastoreId` injected from the bound
data store.

## ListDICOMImportJobs

Runtime binding for the `ListDICOMImportJobs` operation (IAM action
`medical-imaging:ListDICOMImportJobs`), scoped to one {@link Datastore}.

Lists the data store's DICOM import jobs, optionally filtered by
`jobStatus`. Provide the implementation with
`Effect.provide(AWS.MedicalImaging.ListDICOMImportJobsHttp)`.

### Importing DICOM Data
**Example:** List In-Progress Import Jobs
```typescript
const listImportJobs = yield* MedicalImaging.ListDICOMImportJobs(datastore);

const jobs = yield* listImportJobs({ jobStatus: "IN_PROGRESS" });
// jobs.jobSummaries[i].jobId
```

@binding

## ListDICOMImportJobs.Request

`ListDICOMImportJobs` request with `datastoreId` injected from the bound
data store.

## ListImageSetVersions

Runtime binding for the `ListImageSetVersions` operation (IAM action
`medical-imaging:ListImageSetVersions`), scoped to one {@link Datastore}.

Lists every version of an image set — each {@link UpdateImageSetMetadata}
call produces a new version, and older versions remain readable and
revertible. Provide the implementation with
`Effect.provide(AWS.MedicalImaging.ListImageSetVersionsHttp)`.

### Reading Image Sets
**Example:** List an Image Set's Versions
```typescript
const listVersions = yield* MedicalImaging.ListImageSetVersions(datastore);

const versions = yield* listVersions({ imageSetId });
// versions.imageSetPropertiesList[i].versionId
```

@binding

## ListImageSetVersions.Request

`ListImageSetVersions` request with `datastoreId` injected from the bound
data store.

## SearchImageSets

Runtime binding for the `SearchImageSets` operation (IAM action
`medical-imaging:SearchImageSets`), scoped to one {@link Datastore}.

Searches the data store's image sets by DICOM attributes (patient id,
accession number, study/series instance UID, study date/time) or by
created/updated timestamps. Omit `searchCriteria` to page through every
image set. Provide the implementation with
`Effect.provide(AWS.MedicalImaging.SearchImageSetsHttp)`.

### Searching Image Sets
**Example:** Search by Patient Id
```typescript
const searchImageSets = yield* MedicalImaging.SearchImageSets(datastore);

const results = yield* searchImageSets({
  searchCriteria: {
    filters: [{ operator: "EQUAL", values: [{ DICOMPatientId: patientId }] }],
  },
});
// results.imageSetsMetadataSummaries[i].imageSetId
```

**Example:** List Every Image Set
```typescript
const results = yield* searchImageSets();
```

@binding

## SearchImageSets.Request

`SearchImageSets` request with `datastoreId` injected from the bound data
store.

## UpdateImageSetMetadata

Runtime binding for the `UpdateImageSetMetadata` operation (IAM action
`medical-imaging:UpdateImageSetMetadata`), scoped to one
{@link Datastore}.

Adds, updates, or removes DICOM attributes on an image set (each update
produces a new version), or reverts the image set to a previous version
via `revertToVersionId`. Provide the implementation with
`Effect.provide(AWS.MedicalImaging.UpdateImageSetMetadataHttp)`.

### Updating Image Sets
**Example:** Revert an Image Set to a Previous Version
```typescript
const updateMetadata = yield* MedicalImaging.UpdateImageSetMetadata(datastore);

const updated = yield* updateMetadata({
  imageSetId,
  latestVersionId,
  updateImageSetMetadataUpdates: { revertToVersionId: "1" },
});
// updated.latestVersionId
```

@binding

## UpdateImageSetMetadata.Request

`UpdateImageSetMetadata` request with `datastoreId` injected from the
bound data store.
