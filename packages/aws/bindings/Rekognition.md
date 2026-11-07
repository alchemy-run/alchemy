<!-- Docs for the generated AWS.Rekognition bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## AssociateFaces

Runtime binding for `rekognition:AssociateFaces` — associate up to 100 indexed face IDs with a user.

The binding takes no arguments and grants the function
`rekognition:AssociateFaces` on `*` (Rekognition data-plane resources such
as collections, users, and jobs are routinely created at runtime, so
their identifiers are unknown at deploy time). Provide the
implementation with `Effect.provide(AWS.Rekognition.AssociateFacesHttp)`.

### User Search
**Example:** Associate Faces with a User
```typescript
// init
const associateFaces = yield* AWS.Rekognition.AssociateFaces();

// runtime
const result = yield* associateFaces({
  CollectionId: "tenant-42",
  UserId: userId,
  FaceIds: [faceId],
});
// result.AssociatedFaces, result.UserStatus
```

@binding

## CompareFaces

Runtime binding for `rekognition:CompareFaces` — compare the largest face in a source image against faces in a target image and return match confidence.

The binding takes no arguments and grants the function
`rekognition:CompareFaces` on `*` (Rekognition data-plane resources such
as collections, users, and jobs are routinely created at runtime, so
their identifiers are unknown at deploy time). Provide the
implementation with `Effect.provide(AWS.Rekognition.CompareFacesHttp)`.

### Image Analysis
**Example:** Compare Two Face Images
```typescript
// init
const compareFaces = yield* AWS.Rekognition.CompareFaces();

// runtime
const result = yield* compareFaces({
  SourceImage: { S3Object: { Bucket: "photos", Name: "id-card.jpg" } },
  TargetImage: { S3Object: { Bucket: "photos", Name: "selfie.jpg" } },
  SimilarityThreshold: 90,
});
const matches = result.FaceMatches ?? [];
```

@binding

## CreateCollection

Runtime binding for `rekognition:CreateCollection` — create a face collection — e.g. one collection per application tenant, created at runtime.

The binding takes no arguments and grants the function
`rekognition:CreateCollection` on `*` (Rekognition data-plane resources such
as collections, users, and jobs are routinely created at runtime, so
their identifiers are unknown at deploy time). Provide the
implementation with `Effect.provide(AWS.Rekognition.CreateCollectionHttp)`.

### Face Collections
**Example:** Create a Tenant Collection
```typescript
// init
const createCollection = yield* AWS.Rekognition.CreateCollection();

// runtime
const created = yield* createCollection({ CollectionId: `tenant-${tenantId}` });
// created.CollectionArn, created.FaceModelVersion
```

@binding

## CreateFaceLivenessSession

Runtime binding for `rekognition:CreateFaceLivenessSession` — create a Face Liveness session whose ID the client-side FaceLivenessDetector component uses to run the liveness check.

The binding takes no arguments and grants the function
`rekognition:CreateFaceLivenessSession` on `*` (Rekognition data-plane resources such
as collections, users, and jobs are routinely created at runtime, so
their identifiers are unknown at deploy time). Provide the
implementation with `Effect.provide(AWS.Rekognition.CreateFaceLivenessSessionHttp)`.

### Face Liveness
**Example:** Start a Liveness Check
```typescript
// init
const createFaceLivenessSession = yield* AWS.Rekognition.CreateFaceLivenessSession();

// runtime
const session = yield* createFaceLivenessSession({
  Settings: { AuditImagesLimit: 2 },
});
// hand session.SessionId to the front-end FaceLivenessDetector
```

@binding

## CreateUser

Runtime binding for `rekognition:CreateUser` — create a user in a face collection to aggregate multiple face IDs of the same person.

The binding takes no arguments and grants the function
`rekognition:CreateUser` on `*` (Rekognition data-plane resources such
as collections, users, and jobs are routinely created at runtime, so
their identifiers are unknown at deploy time). Provide the
implementation with `Effect.provide(AWS.Rekognition.CreateUserHttp)`.

### User Search
**Example:** Create a User
```typescript
// init
const createUser = yield* AWS.Rekognition.CreateUser();

// runtime
yield* createUser({ CollectionId: "tenant-42", UserId: userId });
```

@binding

## DeleteCollection

Runtime binding for `rekognition:DeleteCollection` — delete a face collection and all faces stored in it.

The binding takes no arguments and grants the function
`rekognition:DeleteCollection` on `*` (Rekognition data-plane resources such
as collections, users, and jobs are routinely created at runtime, so
their identifiers are unknown at deploy time). Provide the
implementation with `Effect.provide(AWS.Rekognition.DeleteCollectionHttp)`.

### Face Collections
**Example:** Delete a Tenant Collection
```typescript
// init
const deleteCollection = yield* AWS.Rekognition.DeleteCollection();

// runtime
yield* deleteCollection({ CollectionId: `tenant-${tenantId}` }).pipe(
  Effect.catchTag("ResourceNotFoundException", () => Effect.void),
);
```

@binding

## DeleteFaces

Runtime binding for `rekognition:DeleteFaces` — delete faces from a face collection by face ID.

The binding takes no arguments and grants the function
`rekognition:DeleteFaces` on `*` (Rekognition data-plane resources such
as collections, users, and jobs are routinely created at runtime, so
their identifiers are unknown at deploy time). Provide the
implementation with `Effect.provide(AWS.Rekognition.DeleteFacesHttp)`.

### Face Collections
**Example:** Delete Faces from a Collection
```typescript
// init
const deleteFaces = yield* AWS.Rekognition.DeleteFaces();

// runtime
const result = yield* deleteFaces({
  CollectionId: "tenant-42",
  FaceIds: [faceId],
});
// result.DeletedFaces, result.UnsuccessfulFaceDeletions
```

@binding

## DeleteUser

Runtime binding for `rekognition:DeleteUser` — delete a user from a face collection.

The binding takes no arguments and grants the function
`rekognition:DeleteUser` on `*` (Rekognition data-plane resources such
as collections, users, and jobs are routinely created at runtime, so
their identifiers are unknown at deploy time). Provide the
implementation with `Effect.provide(AWS.Rekognition.DeleteUserHttp)`.

### User Search
**Example:** Delete a User
```typescript
// init
const deleteUser = yield* AWS.Rekognition.DeleteUser();

// runtime
yield* deleteUser({ CollectionId: "tenant-42", UserId: userId }).pipe(
  Effect.catchTag("ResourceNotFoundException", () => Effect.void),
);
```

@binding

## DescribeCollection

Runtime binding for `rekognition:DescribeCollection` — describe a face collection — face count, face model version, ARN, and creation time.

The binding takes no arguments and grants the function
`rekognition:DescribeCollection` on `*` (Rekognition data-plane resources such
as collections, users, and jobs are routinely created at runtime, so
their identifiers are unknown at deploy time). Provide the
implementation with `Effect.provide(AWS.Rekognition.DescribeCollectionHttp)`.

### Face Collections
**Example:** Describe a Collection
```typescript
// init
const describeCollection = yield* AWS.Rekognition.DescribeCollection();

// runtime
const info = yield* describeCollection({ CollectionId: "tenant-42" });
// info.FaceCount, info.FaceModelVersion
```

@binding

## DescribeProjectVersions

Runtime binding for `rekognition:DescribeProjectVersions` — describe the model versions of a Rekognition project — training status, evaluation results, and hosting status.

The binding takes no arguments and grants the function
`rekognition:DescribeProjectVersions` on `*` (Rekognition data-plane resources such
as collections, users, and jobs are routinely created at runtime, so
their identifiers are unknown at deploy time). Provide the
implementation with `Effect.provide(AWS.Rekognition.DescribeProjectVersionsHttp)`.

### Custom Labels
**Example:** Describe Model Versions
```typescript
// init
const describeProjectVersions = yield* AWS.Rekognition.DescribeProjectVersions();

// runtime
const page = yield* describeProjectVersions({ ProjectArn: projectArn });
// page.ProjectVersionDescriptions
```

@binding

## DescribeProjects

Runtime binding for `rekognition:DescribeProjects` — describe the Rekognition projects (Custom Labels projects and custom moderation adapters) in the account.

The binding takes no arguments and grants the function
`rekognition:DescribeProjects` on `*` (Rekognition data-plane resources such
as collections, users, and jobs are routinely created at runtime, so
their identifiers are unknown at deploy time). Provide the
implementation with `Effect.provide(AWS.Rekognition.DescribeProjectsHttp)`.

### Custom Labels
**Example:** List Projects
```typescript
// init
const describeProjects = yield* AWS.Rekognition.DescribeProjects();

// runtime
const page = yield* describeProjects({ MaxResults: 10 });
// page.ProjectDescriptions
```

@binding

## DescribeStreamProcessor

Runtime binding for `rekognition:DescribeStreamProcessor` — describe a stream processor — status, input/output configuration, and settings.

The binding takes no arguments and grants the function
`rekognition:DescribeStreamProcessor` on `*` (Rekognition data-plane resources such
as collections, users, and jobs are routinely created at runtime, so
their identifiers are unknown at deploy time). Provide the
implementation with `Effect.provide(AWS.Rekognition.DescribeStreamProcessorHttp)`.

### Stream Processors
**Example:** Describe a Stream Processor
```typescript
// init
const describeStreamProcessor = yield* AWS.Rekognition.DescribeStreamProcessor();

// runtime
const info = yield* describeStreamProcessor({ Name: "lobby-camera" });
// info.Status, info.Input, info.Output
```

@binding

## DetectCustomLabels

Runtime binding for `rekognition:DetectCustomLabels` — detect custom labels in an image using a trained and running Rekognition Custom Labels model version.

The binding takes no arguments and grants the function
`rekognition:DetectCustomLabels` on `*` (Rekognition data-plane resources such
as collections, users, and jobs are routinely created at runtime, so
their identifiers are unknown at deploy time). Provide the
implementation with `Effect.provide(AWS.Rekognition.DetectCustomLabelsHttp)`.

### Custom Labels
**Example:** Detect Custom Labels
```typescript
// init
const detectCustomLabels = yield* AWS.Rekognition.DetectCustomLabels();

// runtime
const result = yield* detectCustomLabels({
  ProjectVersionArn: modelArn,
  Image: { Bytes: imageBytes },
  MinConfidence: 70,
});
const labels = (result.CustomLabels ?? []).map((l) => l.Name);
```

@binding

## DetectFaces

Runtime binding for `rekognition:DetectFaces` — detect the 100 largest faces in an image and return facial landmarks, pose, and optional attributes (age range, emotions, etc.).

The binding takes no arguments and grants the function
`rekognition:DetectFaces` on `*` (Rekognition data-plane resources such
as collections, users, and jobs are routinely created at runtime, so
their identifiers are unknown at deploy time). Provide the
implementation with `Effect.provide(AWS.Rekognition.DetectFacesHttp)`.

### Image Analysis
**Example:** Detect Faces with All Attributes
```typescript
// init
const detectFaces = yield* AWS.Rekognition.DetectFaces();

// runtime
const result = yield* detectFaces({
  Image: { Bytes: imageBytes },
  Attributes: ["ALL"],
});
const ages = (result.FaceDetails ?? []).map((f) => f.AgeRange);
```

@binding

## DetectLabels

Runtime binding for `rekognition:DetectLabels` — detect real-world
entities (objects, scenes, concepts) in a JPEG or PNG image.

Rekognition is a pure pay-per-call service with no resource to manage:
the binding takes no arguments and grants the function
`rekognition:DetectLabels` (the action has no resource-level IAM).
Pass the image as raw bytes (`Image.Bytes`) or as an S3 object
reference (`Image.S3Object`) — raw distilled types, no marshalling.
Provide the implementation with
`Effect.provide(AWS.Rekognition.DetectLabelsHttp)`.

### Detecting Labels
**Example:** Detect Labels in Image Bytes
```typescript
// init
const detectLabels = yield* AWS.Rekognition.DetectLabels();

// runtime
const result = yield* detectLabels({
  Image: { Bytes: imageBytes },
  MaxLabels: 10,
  MinConfidence: 50,
});
const names = (result.Labels ?? []).map((label) => label.Name);
```

@binding

## DetectModerationLabels

Runtime binding for `rekognition:DetectModerationLabels` — detect unsafe or inappropriate content (explicit nudity, violence, etc.) in an image for content moderation.

The binding takes no arguments and grants the function
`rekognition:DetectModerationLabels` on `*` (Rekognition data-plane resources such
as collections, users, and jobs are routinely created at runtime, so
their identifiers are unknown at deploy time). Provide the
implementation with `Effect.provide(AWS.Rekognition.DetectModerationLabelsHttp)`.

### Image Analysis
**Example:** Moderate an Uploaded Image
```typescript
// init
const detectModerationLabels = yield* AWS.Rekognition.DetectModerationLabels();

// runtime
const result = yield* detectModerationLabels({
  Image: { Bytes: imageBytes },
  MinConfidence: 60,
});
const flagged = (result.ModerationLabels ?? []).length > 0;
```

@binding

## DetectProtectiveEquipment

Runtime binding for `rekognition:DetectProtectiveEquipment` — detect personal protective equipment (face covers, hand covers, head covers) worn by persons in an image.

The binding takes no arguments and grants the function
`rekognition:DetectProtectiveEquipment` on `*` (Rekognition data-plane resources such
as collections, users, and jobs are routinely created at runtime, so
their identifiers are unknown at deploy time). Provide the
implementation with `Effect.provide(AWS.Rekognition.DetectProtectiveEquipmentHttp)`.

### Image Analysis
**Example:** Check for Face Covers
```typescript
// init
const detectProtectiveEquipment = yield* AWS.Rekognition.DetectProtectiveEquipment();

// runtime
const result = yield* detectProtectiveEquipment({
  Image: { Bytes: imageBytes },
  SummarizationAttributes: {
    MinConfidence: 80,
    RequiredEquipmentTypes: ["FACE_COVER"],
  },
});
```

@binding

## DetectText

Runtime binding for `rekognition:DetectText` — detect and extract lines and words of text in an image.

The binding takes no arguments and grants the function
`rekognition:DetectText` on `*` (Rekognition data-plane resources such
as collections, users, and jobs are routinely created at runtime, so
their identifiers are unknown at deploy time). Provide the
implementation with `Effect.provide(AWS.Rekognition.DetectTextHttp)`.

### Image Analysis
**Example:** Extract Text from an Image
```typescript
// init
const detectText = yield* AWS.Rekognition.DetectText();

// runtime
const result = yield* detectText({ Image: { Bytes: imageBytes } });
const lines = (result.TextDetections ?? [])
  .filter((t) => t.Type === "LINE")
  .map((t) => t.DetectedText);
```

@binding

## DisassociateFaces

Runtime binding for `rekognition:DisassociateFaces` — remove the association between face IDs and a user.

The binding takes no arguments and grants the function
`rekognition:DisassociateFaces` on `*` (Rekognition data-plane resources such
as collections, users, and jobs are routinely created at runtime, so
their identifiers are unknown at deploy time). Provide the
implementation with `Effect.provide(AWS.Rekognition.DisassociateFacesHttp)`.

### User Search
**Example:** Disassociate Faces from a User
```typescript
// init
const disassociateFaces = yield* AWS.Rekognition.DisassociateFaces();

// runtime
const result = yield* disassociateFaces({
  CollectionId: "tenant-42",
  UserId: userId,
  FaceIds: [faceId],
});
```

@binding

## GetCelebrityInfo

Runtime binding for `rekognition:GetCelebrityInfo` — get the name and additional links for a celebrity ID returned by RecognizeCelebrities.

The binding takes no arguments and grants the function
`rekognition:GetCelebrityInfo` on `*` (Rekognition data-plane resources such
as collections, users, and jobs are routinely created at runtime, so
their identifiers are unknown at deploy time). Provide the
implementation with `Effect.provide(AWS.Rekognition.GetCelebrityInfoHttp)`.

### Image Analysis
**Example:** Look Up a Celebrity by ID
```typescript
// init
const getCelebrityInfo = yield* AWS.Rekognition.GetCelebrityInfo();

// runtime
const info = yield* getCelebrityInfo({ Id: celebrityId });
// info.Name, info.Urls, info.KnownGender
```

@binding

## GetCelebrityRecognition

Runtime binding for `rekognition:GetCelebrityRecognition` — get the results of an asynchronous celebrities detection job started by StartCelebrityRecognition.

The binding takes no arguments and grants the function
`rekognition:GetCelebrityRecognition` on `*` (Rekognition data-plane resources such
as collections, users, and jobs are routinely created at runtime, so
their identifiers are unknown at deploy time). Provide the
implementation with `Effect.provide(AWS.Rekognition.GetCelebrityRecognitionHttp)`.

### Video Analysis
**Example:** Poll Celebrity Recognition Results
```typescript
// init
const getCelebrityRecognition = yield* AWS.Rekognition.GetCelebrityRecognition();

// runtime
const results = yield* getCelebrityRecognition({ JobId: jobId });
if (results.JobStatus === "SUCCEEDED") {
  // consume the detections
}
```

@binding

## GetContentModeration

Runtime binding for `rekognition:GetContentModeration` — get the results of an asynchronous inappropriate or offensive content detection job started by StartContentModeration.

The binding takes no arguments and grants the function
`rekognition:GetContentModeration` on `*` (Rekognition data-plane resources such
as collections, users, and jobs are routinely created at runtime, so
their identifiers are unknown at deploy time). Provide the
implementation with `Effect.provide(AWS.Rekognition.GetContentModerationHttp)`.

### Video Analysis
**Example:** Poll Content Moderation Results
```typescript
// init
const getContentModeration = yield* AWS.Rekognition.GetContentModeration();

// runtime
const results = yield* getContentModeration({ JobId: jobId });
if (results.JobStatus === "SUCCEEDED") {
  // consume the detections
}
```

@binding

## GetFaceDetection

Runtime binding for `rekognition:GetFaceDetection` — get the results of an asynchronous faces detection job started by StartFaceDetection.

The binding takes no arguments and grants the function
`rekognition:GetFaceDetection` on `*` (Rekognition data-plane resources such
as collections, users, and jobs are routinely created at runtime, so
their identifiers are unknown at deploy time). Provide the
implementation with `Effect.provide(AWS.Rekognition.GetFaceDetectionHttp)`.

### Video Analysis
**Example:** Poll Face Detection Results
```typescript
// init
const getFaceDetection = yield* AWS.Rekognition.GetFaceDetection();

// runtime
const results = yield* getFaceDetection({ JobId: jobId });
if (results.JobStatus === "SUCCEEDED") {
  // consume the detections
}
```

@binding

## GetFaceLivenessSessionResults

Runtime binding for `rekognition:GetFaceLivenessSessionResults` — get the confidence score, status, and audit images of a completed Face Liveness session.

The binding takes no arguments and grants the function
`rekognition:GetFaceLivenessSessionResults` on `*` (Rekognition data-plane resources such
as collections, users, and jobs are routinely created at runtime, so
their identifiers are unknown at deploy time). Provide the
implementation with `Effect.provide(AWS.Rekognition.GetFaceLivenessSessionResultsHttp)`.

### Face Liveness
**Example:** Fetch Liveness Results
```typescript
// init
const getFaceLivenessSessionResults = yield* AWS.Rekognition.GetFaceLivenessSessionResults();

// runtime
const results = yield* getFaceLivenessSessionResults({
  SessionId: sessionId,
});
const isLive = results.Status === "SUCCEEDED" && (results.Confidence ?? 0) > 80;
```

@binding

## GetFaceSearch

Runtime binding for `rekognition:GetFaceSearch` — get the results of an asynchronous video face search started by StartFaceSearch.

The binding takes no arguments and grants the function
`rekognition:GetFaceSearch` on `*` (Rekognition data-plane resources such
as collections, users, and jobs are routinely created at runtime, so
their identifiers are unknown at deploy time). Provide the
implementation with `Effect.provide(AWS.Rekognition.GetFaceSearchHttp)`.

### Video Analysis
**Example:** Poll Face Search Results
```typescript
// init
const getFaceSearch = yield* AWS.Rekognition.GetFaceSearch();

// runtime
const results = yield* getFaceSearch({ JobId: jobId });
const persons = results.Persons ?? [];
```

@binding

## GetLabelDetection

Runtime binding for `rekognition:GetLabelDetection` — get the results of an asynchronous labels detection job started by StartLabelDetection.

The binding takes no arguments and grants the function
`rekognition:GetLabelDetection` on `*` (Rekognition data-plane resources such
as collections, users, and jobs are routinely created at runtime, so
their identifiers are unknown at deploy time). Provide the
implementation with `Effect.provide(AWS.Rekognition.GetLabelDetectionHttp)`.

### Video Analysis
**Example:** Poll Label Detection Results
```typescript
// init
const getLabelDetection = yield* AWS.Rekognition.GetLabelDetection();

// runtime
const results = yield* getLabelDetection({ JobId: jobId });
if (results.JobStatus === "SUCCEEDED") {
  // consume the detections
}
```

@binding

## GetMediaAnalysisJob

Runtime binding for `rekognition:GetMediaAnalysisJob` — get the status and results location of a media analysis job.

The binding takes no arguments and grants the function
`rekognition:GetMediaAnalysisJob` on `*` (Rekognition data-plane resources such
as collections, users, and jobs are routinely created at runtime, so
their identifiers are unknown at deploy time). Provide the
implementation with `Effect.provide(AWS.Rekognition.GetMediaAnalysisJobHttp)`.

### Media Analysis Jobs
**Example:** Poll a Media Analysis Job
```typescript
// init
const getMediaAnalysisJob = yield* AWS.Rekognition.GetMediaAnalysisJob();

// runtime
const job = yield* getMediaAnalysisJob({ JobId: jobId });
// job.Status, job.Results?.S3Object
```

@binding

## GetPersonTracking

Runtime binding for `rekognition:GetPersonTracking` — get the results of an asynchronous the path of persons detection job started by StartPersonTracking.

The binding takes no arguments and grants the function
`rekognition:GetPersonTracking` on `*` (Rekognition data-plane resources such
as collections, users, and jobs are routinely created at runtime, so
their identifiers are unknown at deploy time). Provide the
implementation with `Effect.provide(AWS.Rekognition.GetPersonTrackingHttp)`.

### Video Analysis
**Example:** Poll Person Tracking Results
```typescript
// init
const getPersonTracking = yield* AWS.Rekognition.GetPersonTracking();

// runtime
const results = yield* getPersonTracking({ JobId: jobId });
if (results.JobStatus === "SUCCEEDED") {
  // consume the detections
}
```

@binding

## GetSegmentDetection

Runtime binding for `rekognition:GetSegmentDetection` — get the results of an asynchronous technical cues and shot segments detection job started by StartSegmentDetection.

The binding takes no arguments and grants the function
`rekognition:GetSegmentDetection` on `*` (Rekognition data-plane resources such
as collections, users, and jobs are routinely created at runtime, so
their identifiers are unknown at deploy time). Provide the
implementation with `Effect.provide(AWS.Rekognition.GetSegmentDetectionHttp)`.

### Video Analysis
**Example:** Poll Segment Detection Results
```typescript
// init
const getSegmentDetection = yield* AWS.Rekognition.GetSegmentDetection();

// runtime
const results = yield* getSegmentDetection({ JobId: jobId });
if (results.JobStatus === "SUCCEEDED") {
  // consume the detections
}
```

@binding

## GetTextDetection

Runtime binding for `rekognition:GetTextDetection` — get the results of an asynchronous text detection job started by StartTextDetection.

The binding takes no arguments and grants the function
`rekognition:GetTextDetection` on `*` (Rekognition data-plane resources such
as collections, users, and jobs are routinely created at runtime, so
their identifiers are unknown at deploy time). Provide the
implementation with `Effect.provide(AWS.Rekognition.GetTextDetectionHttp)`.

### Video Analysis
**Example:** Poll Text Detection Results
```typescript
// init
const getTextDetection = yield* AWS.Rekognition.GetTextDetection();

// runtime
const results = yield* getTextDetection({ JobId: jobId });
if (results.JobStatus === "SUCCEEDED") {
  // consume the detections
}
```

@binding

## IndexFaces

Runtime binding for `rekognition:IndexFaces` — detect faces in an image and add them to a face collection for later search.

The binding takes no arguments and grants the function
`rekognition:IndexFaces` on `*` (Rekognition data-plane resources such
as collections, users, and jobs are routinely created at runtime, so
their identifiers are unknown at deploy time). Provide the
implementation with `Effect.provide(AWS.Rekognition.IndexFacesHttp)`.

### Face Collections
**Example:** Index Faces into a Collection
```typescript
// init
const indexFaces = yield* AWS.Rekognition.IndexFaces();

// runtime
const result = yield* indexFaces({
  CollectionId: "tenant-42",
  Image: { S3Object: { Bucket: "photos", Name: "profile.jpg" } },
  ExternalImageId: userId,
});
const faceIds = (result.FaceRecords ?? []).map((r) => r.Face?.FaceId);
```

@binding

## ListCollections

Runtime binding for `rekognition:ListCollections` — list the face collection IDs in the account.

The binding takes no arguments and grants the function
`rekognition:ListCollections` on `*` (Rekognition data-plane resources such
as collections, users, and jobs are routinely created at runtime, so
their identifiers are unknown at deploy time). Provide the
implementation with `Effect.provide(AWS.Rekognition.ListCollectionsHttp)`.

### Face Collections
**Example:** List Collections
```typescript
// init
const listCollections = yield* AWS.Rekognition.ListCollections();

// runtime
const page = yield* listCollections({ MaxResults: 20 });
// page.CollectionIds, page.NextToken
```

@binding

## ListFaces

Runtime binding for `rekognition:ListFaces` — list the metadata of faces stored in a face collection.

The binding takes no arguments and grants the function
`rekognition:ListFaces` on `*` (Rekognition data-plane resources such
as collections, users, and jobs are routinely created at runtime, so
their identifiers are unknown at deploy time). Provide the
implementation with `Effect.provide(AWS.Rekognition.ListFacesHttp)`.

### Face Collections
**Example:** List Faces in a Collection
```typescript
// init
const listFaces = yield* AWS.Rekognition.ListFaces();

// runtime
const page = yield* listFaces({ CollectionId: "tenant-42", MaxResults: 100 });
// page.Faces, page.NextToken
```

@binding

## ListMediaAnalysisJobs

Runtime binding for `rekognition:ListMediaAnalysisJobs` — list the media analysis jobs in the account.

The binding takes no arguments and grants the function
`rekognition:ListMediaAnalysisJobs` on `*` (Rekognition data-plane resources such
as collections, users, and jobs are routinely created at runtime, so
their identifiers are unknown at deploy time). Provide the
implementation with `Effect.provide(AWS.Rekognition.ListMediaAnalysisJobsHttp)`.

### Media Analysis Jobs
**Example:** List Media Analysis Jobs
```typescript
// init
const listMediaAnalysisJobs = yield* AWS.Rekognition.ListMediaAnalysisJobs();

// runtime
const page = yield* listMediaAnalysisJobs({ MaxResults: 10 });
// page.MediaAnalysisJobs
```

@binding

## ListStreamProcessors

Runtime binding for `rekognition:ListStreamProcessors` — list the stream processors in the account.

The binding takes no arguments and grants the function
`rekognition:ListStreamProcessors` on `*` (Rekognition data-plane resources such
as collections, users, and jobs are routinely created at runtime, so
their identifiers are unknown at deploy time). Provide the
implementation with `Effect.provide(AWS.Rekognition.ListStreamProcessorsHttp)`.

### Stream Processors
**Example:** List Stream Processors
```typescript
// init
const listStreamProcessors = yield* AWS.Rekognition.ListStreamProcessors();

// runtime
const page = yield* listStreamProcessors({ MaxResults: 10 });
// page.StreamProcessors
```

@binding

## ListUsers

Runtime binding for `rekognition:ListUsers` — list the users in a face collection.

The binding takes no arguments and grants the function
`rekognition:ListUsers` on `*` (Rekognition data-plane resources such
as collections, users, and jobs are routinely created at runtime, so
their identifiers are unknown at deploy time). Provide the
implementation with `Effect.provide(AWS.Rekognition.ListUsersHttp)`.

### User Search
**Example:** List Users in a Collection
```typescript
// init
const listUsers = yield* AWS.Rekognition.ListUsers();

// runtime
const page = yield* listUsers({ CollectionId: "tenant-42" });
const userIds = (page.Users ?? []).map((u) => u.UserId);
```

@binding

## RecognizeCelebrities

Runtime binding for `rekognition:RecognizeCelebrities` — recognize up to 64 celebrities in an image.

The binding takes no arguments and grants the function
`rekognition:RecognizeCelebrities` on `*` (Rekognition data-plane resources such
as collections, users, and jobs are routinely created at runtime, so
their identifiers are unknown at deploy time). Provide the
implementation with `Effect.provide(AWS.Rekognition.RecognizeCelebritiesHttp)`.

### Image Analysis
**Example:** Recognize Celebrities in a Photo
```typescript
// init
const recognizeCelebrities = yield* AWS.Rekognition.RecognizeCelebrities();

// runtime
const result = yield* recognizeCelebrities({
  Image: { S3Object: { Bucket: "photos", Name: "red-carpet.jpg" } },
});
const names = (result.CelebrityFaces ?? []).map((c) => c.Name);
```

@binding

## SearchFaces

Runtime binding for `rekognition:SearchFaces` — search a face collection for faces matching a face ID already stored in the collection.

The binding takes no arguments and grants the function
`rekognition:SearchFaces` on `*` (Rekognition data-plane resources such
as collections, users, and jobs are routinely created at runtime, so
their identifiers are unknown at deploy time). Provide the
implementation with `Effect.provide(AWS.Rekognition.SearchFacesHttp)`.

### Face Collections
**Example:** Search by Face ID
```typescript
// init
const searchFaces = yield* AWS.Rekognition.SearchFaces();

// runtime
const result = yield* searchFaces({
  CollectionId: "tenant-42",
  FaceId: faceId,
  FaceMatchThreshold: 95,
});
const matches = result.FaceMatches ?? [];
```

@binding

## SearchFacesByImage

Runtime binding for `rekognition:SearchFacesByImage` — search a face collection for faces matching the largest face in a supplied image.

The binding takes no arguments and grants the function
`rekognition:SearchFacesByImage` on `*` (Rekognition data-plane resources such
as collections, users, and jobs are routinely created at runtime, so
their identifiers are unknown at deploy time). Provide the
implementation with `Effect.provide(AWS.Rekognition.SearchFacesByImageHttp)`.

### Face Collections
**Example:** Search by Image
```typescript
// init
const searchFacesByImage = yield* AWS.Rekognition.SearchFacesByImage();

// runtime
const result = yield* searchFacesByImage({
  CollectionId: "tenant-42",
  Image: { Bytes: imageBytes },
  FaceMatchThreshold: 95,
});
const bestMatch = result.FaceMatches?.[0]?.Face?.ExternalImageId;
```

@binding

## SearchUsers

Runtime binding for `rekognition:SearchUsers` — search a face collection for users matching a face ID or user ID.

The binding takes no arguments and grants the function
`rekognition:SearchUsers` on `*` (Rekognition data-plane resources such
as collections, users, and jobs are routinely created at runtime, so
their identifiers are unknown at deploy time). Provide the
implementation with `Effect.provide(AWS.Rekognition.SearchUsersHttp)`.

### User Search
**Example:** Search Users by Face ID
```typescript
// init
const searchUsers = yield* AWS.Rekognition.SearchUsers();

// runtime
const result = yield* searchUsers({
  CollectionId: "tenant-42",
  FaceId: faceId,
});
const matches = result.UserMatches ?? [];
```

@binding

## SearchUsersByImage

Runtime binding for `rekognition:SearchUsersByImage` — search a face collection for users matching the largest face in a supplied image.

The binding takes no arguments and grants the function
`rekognition:SearchUsersByImage` on `*` (Rekognition data-plane resources such
as collections, users, and jobs are routinely created at runtime, so
their identifiers are unknown at deploy time). Provide the
implementation with `Effect.provide(AWS.Rekognition.SearchUsersByImageHttp)`.

### User Search
**Example:** Search Users by Image
```typescript
// init
const searchUsersByImage = yield* AWS.Rekognition.SearchUsersByImage();

// runtime
const result = yield* searchUsersByImage({
  CollectionId: "tenant-42",
  Image: { Bytes: imageBytes },
});
const bestUser = result.UserMatches?.[0]?.User?.UserId;
```

@binding

## StartCelebrityRecognition

Runtime binding for `rekognition:StartCelebrityRecognition` — start asynchronous detection of celebrities in a stored video.

Rekognition Video jobs read the video from S3 and run asynchronously —
poll the paired `Get*` binding with the returned `JobId`, or pass a
`NotificationChannel` (SNS topic + IAM role the caller must be allowed
to pass) to be notified on completion.

The binding takes no arguments and grants the function
`rekognition:StartCelebrityRecognition` on `*` (Rekognition data-plane resources such
as collections, users, and jobs are routinely created at runtime, so
their identifiers are unknown at deploy time). Provide the
implementation with `Effect.provide(AWS.Rekognition.StartCelebrityRecognitionHttp)`.

### Video Analysis
**Example:** Start Celebrity Recognition
```typescript
// init
const startCelebrityRecognition = yield* AWS.Rekognition.StartCelebrityRecognition();

// runtime
const started = yield* startCelebrityRecognition({
  Video: { S3Object: { Bucket: "videos", Name: "input.mp4" } },
});
// started.JobId
```

@binding

## StartContentModeration

Runtime binding for `rekognition:StartContentModeration` — start asynchronous detection of inappropriate or offensive content in a stored video.

Rekognition Video jobs read the video from S3 and run asynchronously —
poll the paired `Get*` binding with the returned `JobId`, or pass a
`NotificationChannel` (SNS topic + IAM role the caller must be allowed
to pass) to be notified on completion.

The binding takes no arguments and grants the function
`rekognition:StartContentModeration` on `*` (Rekognition data-plane resources such
as collections, users, and jobs are routinely created at runtime, so
their identifiers are unknown at deploy time). Provide the
implementation with `Effect.provide(AWS.Rekognition.StartContentModerationHttp)`.

### Video Analysis
**Example:** Start Content Moderation
```typescript
// init
const startContentModeration = yield* AWS.Rekognition.StartContentModeration();

// runtime
const started = yield* startContentModeration({
  Video: { S3Object: { Bucket: "videos", Name: "input.mp4" } },
});
// started.JobId
```

@binding

## StartFaceDetection

Runtime binding for `rekognition:StartFaceDetection` — start asynchronous detection of faces in a stored video.

Rekognition Video jobs read the video from S3 and run asynchronously —
poll the paired `Get*` binding with the returned `JobId`, or pass a
`NotificationChannel` (SNS topic + IAM role the caller must be allowed
to pass) to be notified on completion.

The binding takes no arguments and grants the function
`rekognition:StartFaceDetection` on `*` (Rekognition data-plane resources such
as collections, users, and jobs are routinely created at runtime, so
their identifiers are unknown at deploy time). Provide the
implementation with `Effect.provide(AWS.Rekognition.StartFaceDetectionHttp)`.

### Video Analysis
**Example:** Start Face Detection
```typescript
// init
const startFaceDetection = yield* AWS.Rekognition.StartFaceDetection();

// runtime
const started = yield* startFaceDetection({
  Video: { S3Object: { Bucket: "videos", Name: "input.mp4" } },
});
// started.JobId
```

@binding

## StartFaceSearch

Runtime binding for `rekognition:StartFaceSearch` — start an asynchronous search of a stored video for faces matching a face collection.

Rekognition Video jobs read the video from S3 and run asynchronously —
poll the paired `Get*` binding with the returned `JobId`, or pass a
`NotificationChannel` (SNS topic + IAM role the caller must be allowed
to pass) to be notified on completion.

The binding takes no arguments and grants the function
`rekognition:StartFaceSearch` on `*` (Rekognition data-plane resources such
as collections, users, and jobs are routinely created at runtime, so
their identifiers are unknown at deploy time). Provide the
implementation with `Effect.provide(AWS.Rekognition.StartFaceSearchHttp)`.

### Video Analysis
**Example:** Start a Video Face Search
```typescript
// init
const startFaceSearch = yield* AWS.Rekognition.StartFaceSearch();

// runtime
const started = yield* startFaceSearch({
  Video: { S3Object: { Bucket: "videos", Name: "lobby.mp4" } },
  CollectionId: "tenant-42",
});
// started.JobId
```

@binding

## StartLabelDetection

Runtime binding for `rekognition:StartLabelDetection` — start asynchronous detection of labels (objects, scenes, activities) in a stored video.

Rekognition Video jobs read the video from S3 and run asynchronously —
poll the paired `Get*` binding with the returned `JobId`, or pass a
`NotificationChannel` (SNS topic + IAM role the caller must be allowed
to pass) to be notified on completion.

The binding takes no arguments and grants the function
`rekognition:StartLabelDetection` on `*` (Rekognition data-plane resources such
as collections, users, and jobs are routinely created at runtime, so
their identifiers are unknown at deploy time). Provide the
implementation with `Effect.provide(AWS.Rekognition.StartLabelDetectionHttp)`.

### Video Analysis
**Example:** Start Label Detection
```typescript
// init
const startLabelDetection = yield* AWS.Rekognition.StartLabelDetection();

// runtime
const started = yield* startLabelDetection({
  Video: { S3Object: { Bucket: "videos", Name: "input.mp4" } },
});
// started.JobId
```

@binding

## StartMediaAnalysisJob

Runtime binding for `rekognition:StartMediaAnalysisJob` — start an asynchronous media analysis job (e.g. bulk content moderation) over an S3 manifest of images.

The binding takes no arguments and grants the function
`rekognition:StartMediaAnalysisJob` on `*` (Rekognition data-plane resources such
as collections, users, and jobs are routinely created at runtime, so
their identifiers are unknown at deploy time). Provide the
implementation with `Effect.provide(AWS.Rekognition.StartMediaAnalysisJobHttp)`.

### Media Analysis Jobs
**Example:** Start a Bulk Moderation Job
```typescript
// init
const startMediaAnalysisJob = yield* AWS.Rekognition.StartMediaAnalysisJob();

// runtime
const started = yield* startMediaAnalysisJob({
  OperationsConfig: { DetectModerationLabels: { MinConfidence: 60 } },
  Input: { S3Object: { Bucket: "media", Name: "manifest.jsonl" } },
  OutputConfig: { S3Bucket: "media", S3KeyPrefix: "results/" },
});
// started.JobId
```

@binding

## StartPersonTracking

Runtime binding for `rekognition:StartPersonTracking` — start asynchronous detection of the path of persons in a stored video.

Rekognition Video jobs read the video from S3 and run asynchronously —
poll the paired `Get*` binding with the returned `JobId`, or pass a
`NotificationChannel` (SNS topic + IAM role the caller must be allowed
to pass) to be notified on completion.

The binding takes no arguments and grants the function
`rekognition:StartPersonTracking` on `*` (Rekognition data-plane resources such
as collections, users, and jobs are routinely created at runtime, so
their identifiers are unknown at deploy time). Provide the
implementation with `Effect.provide(AWS.Rekognition.StartPersonTrackingHttp)`.

### Video Analysis
**Example:** Start Person Tracking
```typescript
// init
const startPersonTracking = yield* AWS.Rekognition.StartPersonTracking();

// runtime
const started = yield* startPersonTracking({
  Video: { S3Object: { Bucket: "videos", Name: "input.mp4" } },
});
// started.JobId
```

@binding

## StartProjectVersion

Runtime binding for `rekognition:StartProjectVersion` — start hosting a trained Custom Labels model version so it can serve DetectCustomLabels requests.

The binding takes no arguments and grants the function
`rekognition:StartProjectVersion` on `*` (Rekognition data-plane resources such
as collections, users, and jobs are routinely created at runtime, so
their identifiers are unknown at deploy time). Provide the
implementation with `Effect.provide(AWS.Rekognition.StartProjectVersionHttp)`.

### Custom Labels
**Example:** Start a Model Version
```typescript
// init
const startProjectVersion = yield* AWS.Rekognition.StartProjectVersion();

// runtime
const started = yield* startProjectVersion({
  ProjectVersionArn: modelArn,
  MinInferenceUnits: 1,
});
// started.Status
```

@binding

## StartSegmentDetection

Runtime binding for `rekognition:StartSegmentDetection` — start asynchronous detection of technical cues and shot segments in a stored video.

Rekognition Video jobs read the video from S3 and run asynchronously —
poll the paired `Get*` binding with the returned `JobId`, or pass a
`NotificationChannel` (SNS topic + IAM role the caller must be allowed
to pass) to be notified on completion.

The binding takes no arguments and grants the function
`rekognition:StartSegmentDetection` on `*` (Rekognition data-plane resources such
as collections, users, and jobs are routinely created at runtime, so
their identifiers are unknown at deploy time). Provide the
implementation with `Effect.provide(AWS.Rekognition.StartSegmentDetectionHttp)`.

### Video Analysis
**Example:** Start Segment Detection
```typescript
// init
const startSegmentDetection = yield* AWS.Rekognition.StartSegmentDetection();

// runtime
const started = yield* startSegmentDetection({
  Video: { S3Object: { Bucket: "videos", Name: "input.mp4" } },
});
// started.JobId
```

@binding

## StartStreamProcessor

Runtime binding for `rekognition:StartStreamProcessor` — start a stream processor that analyzes a Kinesis Video Stream (face search or connected-home label detection).

The binding takes no arguments and grants the function
`rekognition:StartStreamProcessor` on `*` (Rekognition data-plane resources such
as collections, users, and jobs are routinely created at runtime, so
their identifiers are unknown at deploy time). Provide the
implementation with `Effect.provide(AWS.Rekognition.StartStreamProcessorHttp)`.

### Stream Processors
**Example:** Start a Stream Processor
```typescript
// init
const startStreamProcessor = yield* AWS.Rekognition.StartStreamProcessor();

// runtime
const started = yield* startStreamProcessor({ Name: "lobby-camera" });
// started.SessionId (connected-home processors)
```

@binding

## StartTextDetection

Runtime binding for `rekognition:StartTextDetection` — start asynchronous detection of text in a stored video.

Rekognition Video jobs read the video from S3 and run asynchronously —
poll the paired `Get*` binding with the returned `JobId`, or pass a
`NotificationChannel` (SNS topic + IAM role the caller must be allowed
to pass) to be notified on completion.

The binding takes no arguments and grants the function
`rekognition:StartTextDetection` on `*` (Rekognition data-plane resources such
as collections, users, and jobs are routinely created at runtime, so
their identifiers are unknown at deploy time). Provide the
implementation with `Effect.provide(AWS.Rekognition.StartTextDetectionHttp)`.

### Video Analysis
**Example:** Start Text Detection
```typescript
// init
const startTextDetection = yield* AWS.Rekognition.StartTextDetection();

// runtime
const started = yield* startTextDetection({
  Video: { S3Object: { Bucket: "videos", Name: "input.mp4" } },
});
// started.JobId
```

@binding

## StopProjectVersion

Runtime binding for `rekognition:StopProjectVersion` — stop hosting a Custom Labels model version to stop incurring inference-unit charges.

The binding takes no arguments and grants the function
`rekognition:StopProjectVersion` on `*` (Rekognition data-plane resources such
as collections, users, and jobs are routinely created at runtime, so
their identifiers are unknown at deploy time). Provide the
implementation with `Effect.provide(AWS.Rekognition.StopProjectVersionHttp)`.

### Custom Labels
**Example:** Stop a Model Version
```typescript
// init
const stopProjectVersion = yield* AWS.Rekognition.StopProjectVersion();

// runtime
const stopped = yield* stopProjectVersion({ ProjectVersionArn: modelArn });
// stopped.Status
```

@binding

## StopStreamProcessor

Runtime binding for `rekognition:StopStreamProcessor` — stop a running stream processor.

The binding takes no arguments and grants the function
`rekognition:StopStreamProcessor` on `*` (Rekognition data-plane resources such
as collections, users, and jobs are routinely created at runtime, so
their identifiers are unknown at deploy time). Provide the
implementation with `Effect.provide(AWS.Rekognition.StopStreamProcessorHttp)`.

### Stream Processors
**Example:** Stop a Stream Processor
```typescript
// init
const stopStreamProcessor = yield* AWS.Rekognition.StopStreamProcessor();

// runtime
yield* stopStreamProcessor({ Name: "lobby-camera" });
```

@binding
