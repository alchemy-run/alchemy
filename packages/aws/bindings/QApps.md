<!-- Docs for the generated AWS.QApps bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## AssociateLibraryItemReview

Runtime binding for `qapps:AssociateLibraryItemReview`.

Upvotes a library item as the calling identity. Provide the implementation with
`Effect.provide(AWS.QApps.AssociateLibraryItemReviewHttp)`.
### Library Items
**Example:** Upvote a Library Item
```typescript
// init — bind the operation to the Q App
const associateLibraryItemReview = yield* AWS.QApps.AssociateLibraryItemReview(app);

// runtime
yield* associateLibraryItemReview({ libraryItemId });
```

@binding

## AssociateLibraryItemReview.Request

Request for {@link AssociateLibraryItemReview} — `instanceId` is injected from the bound Q App.

## AssociateQAppWithUser

Runtime binding for `qapps:AssociateQAppWithUser`.

Links the calling identity to the bound Q App, marking it as a favorite in the user's inventory. Provide the implementation with
`Effect.provide(AWS.QApps.AssociateQAppWithUserHttp)`.
### User Inventory
**Example:** Favorite the App
```typescript
// init — bind the operation to the Q App
const associateQAppWithUser = yield* AWS.QApps.AssociateQAppWithUser(app);

// runtime
yield* associateQAppWithUser();
```

@binding

## AssociateQAppWithUser.Request

Request for {@link AssociateQAppWithUser} — `instanceId` and `appId` are injected from the bound Q App.

## BatchCreateCategory

Runtime binding for `qapps:BatchCreateCategory`.

Creates library categories that web-experience users use to tag and filter library items. Provide the implementation with
`Effect.provide(AWS.QApps.BatchCreateCategoryHttp)`.
### Categories
**Example:** Create Categories
```typescript
// init — bind the operation to the Q App
const batchCreateCategory = yield* AWS.QApps.BatchCreateCategory(app);

// runtime
yield* batchCreateCategory({
  categories: [{ title: "HR" }, { title: "Marketing" }],
});
```

@binding

## BatchCreateCategory.Request

Request for {@link BatchCreateCategory} — `instanceId` is injected from the bound Q App.

## BatchDeleteCategory

Runtime binding for `qapps:BatchDeleteCategory`.

Deletes library categories by id. Provide the implementation with
`Effect.provide(AWS.QApps.BatchDeleteCategoryHttp)`.
### Categories
**Example:** Delete Categories
```typescript
// init — bind the operation to the Q App
const batchDeleteCategory = yield* AWS.QApps.BatchDeleteCategory(app);

// runtime
yield* batchDeleteCategory({ categories: [categoryId] });
```

@binding

## BatchDeleteCategory.Request

Request for {@link BatchDeleteCategory} — `instanceId` is injected from the bound Q App.

## BatchUpdateCategory

Runtime binding for `qapps:BatchUpdateCategory`.

Renames or recolors existing library categories. Provide the implementation with
`Effect.provide(AWS.QApps.BatchUpdateCategoryHttp)`.
### Categories
**Example:** Rename a Category
```typescript
// init — bind the operation to the Q App
const batchUpdateCategory = yield* AWS.QApps.BatchUpdateCategory(app);

// runtime
yield* batchUpdateCategory({
  categories: [{ id: categoryId, title: "People Ops" }],
});
```

@binding

## BatchUpdateCategory.Request

Request for {@link BatchUpdateCategory} — `instanceId` is injected from the bound Q App.

## CreateLibraryItem

Runtime binding for `qapps:CreateLibraryItem`.

Publishes a version of the bound Q App into the instance's library so other users can discover and run it. Provide the implementation with
`Effect.provide(AWS.QApps.CreateLibraryItemHttp)`.
### Library Items
**Example:** Publish the App to the Library
```typescript
// init — bind the operation to the Q App
const createLibraryItem = yield* AWS.QApps.CreateLibraryItem(app);

// runtime
const item = yield* createLibraryItem({
  appVersion: 1,
  categories: [categoryId],
});
console.log(item.libraryItemId);
```

@binding

## CreateLibraryItem.Request

Request for {@link CreateLibraryItem} — `instanceId` and `appId` are injected from the bound Q App.

## CreatePresignedUrl

Runtime binding for `qapps:CreatePresignedUrl`.

Creates a presigned upload URL for a file-upload card of the bound Q App. Provide the implementation with
`Effect.provide(AWS.QApps.CreatePresignedUrlHttp)`.
### Files
**Example:** Create a Presigned Upload URL
```typescript
// init — bind the operation to the Q App
const createPresignedUrl = yield* AWS.QApps.CreatePresignedUrl(app);

// runtime
const upload = yield* createPresignedUrl({
  cardId,
  fileContentsSha256,
  fileName: "report.pdf",
  scope: "SESSION",
  sessionId,
});
console.log(upload.presignedUrl);
```

@binding

## CreatePresignedUrl.Request

Request for {@link CreatePresignedUrl} — `instanceId` and `appId` are injected from the bound Q App.

## DeleteLibraryItem

Runtime binding for `qapps:DeleteLibraryItem`.

Unpublishes a library item, removing the app from the instance's library. Provide the implementation with
`Effect.provide(AWS.QApps.DeleteLibraryItemHttp)`.
### Library Items
**Example:** Delete a Library Item
```typescript
// init — bind the operation to the Q App
const deleteLibraryItem = yield* AWS.QApps.DeleteLibraryItem(app);

// runtime
yield* deleteLibraryItem({ libraryItemId });
```

@binding

## DeleteLibraryItem.Request

Request for {@link DeleteLibraryItem} — `instanceId` is injected from the bound Q App.

## DescribeQAppPermissions

Runtime binding for `qapps:DescribeQAppPermissions`.

Reads the principals and actions granted on the bound Q App. Provide the implementation with
`Effect.provide(AWS.QApps.DescribeQAppPermissionsHttp)`.
### Permissions
**Example:** Describe App Permissions
```typescript
// init — bind the operation to the Q App
const describeQAppPermissions = yield* AWS.QApps.DescribeQAppPermissions(app);

// runtime
const permissions = yield* describeQAppPermissions();
console.log(permissions.permissions?.length);
```

@binding

## DescribeQAppPermissions.Request

Request for {@link DescribeQAppPermissions} — `instanceId` and `appId` are injected from the bound Q App.

## DisassociateLibraryItemReview

Runtime binding for `qapps:DisassociateLibraryItemReview`.

Removes the calling identity's upvote from a library item. Provide the implementation with
`Effect.provide(AWS.QApps.DisassociateLibraryItemReviewHttp)`.
### Library Items
**Example:** Remove an Upvote
```typescript
// init — bind the operation to the Q App
const disassociateLibraryItemReview = yield* AWS.QApps.DisassociateLibraryItemReview(app);

// runtime
yield* disassociateLibraryItemReview({ libraryItemId });
```

@binding

## DisassociateLibraryItemReview.Request

Request for {@link DisassociateLibraryItemReview} — `instanceId` is injected from the bound Q App.

## DisassociateQAppFromUser

Runtime binding for `qapps:DisassociateQAppFromUser`.

Removes the bound Q App from the calling identity's inventory of favorited apps. Provide the implementation with
`Effect.provide(AWS.QApps.DisassociateQAppFromUserHttp)`.
### User Inventory
**Example:** Unfavorite the App
```typescript
// init — bind the operation to the Q App
const disassociateQAppFromUser = yield* AWS.QApps.DisassociateQAppFromUser(app);

// runtime
yield* disassociateQAppFromUser();
```

@binding

## DisassociateQAppFromUser.Request

Request for {@link DisassociateQAppFromUser} — `instanceId` and `appId` are injected from the bound Q App.

## ExportQAppSessionData

Runtime binding for `qapps:ExportQAppSessionData`.

Exports a shared Q App session's collected data as a downloadable CSV file link. Provide the implementation with
`Effect.provide(AWS.QApps.ExportQAppSessionDataHttp)`.
### Sessions
**Example:** Export Session Data
```typescript
// init — bind the operation to the Q App
const exportQAppSessionData = yield* AWS.QApps.ExportQAppSessionData(app);

// runtime
const exported = yield* exportQAppSessionData({ sessionId });
console.log(exported.csvFileLink);
```

@binding

## ExportQAppSessionData.Request

Request for {@link ExportQAppSessionData} — `instanceId` is injected from the bound Q App.

## GetLibraryItem

Runtime binding for `qapps:GetLibraryItem`.

Retrieves a library item — its published app version, categories, status, and rating counts. Provide the implementation with
`Effect.provide(AWS.QApps.GetLibraryItemHttp)`.
### Library Items
**Example:** Read a Library Item
```typescript
// init — bind the operation to the Q App
const getLibraryItem = yield* AWS.QApps.GetLibraryItem(app);

// runtime
const item = yield* getLibraryItem({ libraryItemId });
console.log(item.ratingCount);
```

@binding

## GetLibraryItem.Request

Request for {@link GetLibraryItem} — `instanceId` is injected from the bound Q App.

## GetQAppSession

Runtime binding for `qapps:GetQAppSession`.

Retrieves the current state of a Q App session — execution status plus the per-card status map. Provide the implementation with
`Effect.provide(AWS.QApps.GetQAppSessionHttp)`.
### Sessions
**Example:** Poll a Session Until It Completes
```typescript
// init — bind the operation to the Q App
const getQAppSession = yield* AWS.QApps.GetQAppSession(app);

// runtime
const state = yield* getQAppSession({ sessionId });
if (state.status === "COMPLETED") console.log(state.cardStatus);
```

@binding

## GetQAppSession.Request

Request for {@link GetQAppSession} — `instanceId` is injected from the bound Q App.

## GetQAppSessionMetadata

Runtime binding for `qapps:GetQAppSessionMetadata`.

Retrieves a Q App session's metadata — name, sharing configuration, and ownership. Provide the implementation with
`Effect.provide(AWS.QApps.GetQAppSessionMetadataHttp)`.
### Sessions
**Example:** Read Session Sharing Configuration
```typescript
// init — bind the operation to the Q App
const getQAppSessionMetadata = yield* AWS.QApps.GetQAppSessionMetadata(app);

// runtime
const metadata = yield* getQAppSessionMetadata({ sessionId });
console.log(metadata.sharingConfiguration.enabled);
```

@binding

## GetQAppSessionMetadata.Request

Request for {@link GetQAppSessionMetadata} — `instanceId` is injected from the bound Q App.

## ImportDocument

Runtime binding for `qapps:ImportDocument`.

Uploads a base64-encoded file into a card of the bound Q App, at app or session scope. Provide the implementation with
`Effect.provide(AWS.QApps.ImportDocumentHttp)`.
### Files
**Example:** Import a Document
```typescript
// init — bind the operation to the Q App
const importDocument = yield* AWS.QApps.ImportDocument(app);

// runtime
const imported = yield* importDocument({
  cardId,
  fileContentsBase64,
  fileName: "notes.txt",
  scope: "SESSION",
  sessionId,
});
console.log(imported.fileId);
```

@binding

## ImportDocument.Request

Request for {@link ImportDocument} — `instanceId` and `appId` are injected from the bound Q App.

## ListCategories

Runtime binding for `qapps:ListCategories`.

Lists the library categories of the bound app's Q Business application environment instance. Provide the implementation with
`Effect.provide(AWS.QApps.ListCategoriesHttp)`.
### Categories
**Example:** List Categories
```typescript
// init — bind the operation to the Q App
const listCategories = yield* AWS.QApps.ListCategories(app);

// runtime
const result = yield* listCategories();
console.log(result.categories?.map((c) => c.title));
```

@binding

## ListCategories.Request

Request for {@link ListCategories} — `instanceId` is injected from the bound Q App.

## ListLibraryItems

Runtime binding for `qapps:ListLibraryItems`.

Lists the library items published in the bound app's Q Business application environment instance. Provide the implementation with
`Effect.provide(AWS.QApps.ListLibraryItemsHttp)`.
### Library Items
**Example:** List Library Items
```typescript
// init — bind the operation to the Q App
const listLibraryItems = yield* AWS.QApps.ListLibraryItems(app);

// runtime
const page = yield* listLibraryItems({ limit: 25 });
console.log(page.libraryItems?.length);
```

@binding

## ListLibraryItems.Request

Request for {@link ListLibraryItems} — `instanceId` is injected from the bound Q App.

## ListQAppSessionData

Runtime binding for `qapps:ListQAppSessionData`.

Lists the per-user data collected in a shared Q App session. Provide the implementation with
`Effect.provide(AWS.QApps.ListQAppSessionDataHttp)`.
### Sessions
**Example:** List Session Data
```typescript
// init — bind the operation to the Q App
const listQAppSessionData = yield* AWS.QApps.ListQAppSessionData(app);

// runtime
const data = yield* listQAppSessionData({ sessionId });
console.log(data.sessionData?.length);
```

@binding

## ListQAppSessionData.Request

Request for {@link ListQAppSessionData} — `instanceId` is injected from the bound Q App.

## ListQApps

Runtime binding for `qapps:ListQApps`.

Lists the calling identity's Q Apps in the bound app's Q Business application environment instance. Provide the implementation with
`Effect.provide(AWS.QApps.ListQAppsHttp)`.
### User Inventory
**Example:** List the User's Q Apps
```typescript
// init — bind the operation to the Q App
const listQApps = yield* AWS.QApps.ListQApps(app);

// runtime
const page = yield* listQApps({ limit: 25 });
console.log(page.apps.map((a) => a.title));
```

@binding

## ListQApps.Request

Request for {@link ListQApps} — `instanceId` is injected from the bound Q App.

## PredictQApp

Runtime binding for `qapps:PredictQApp`.

Generates a Q App definition from a natural-language problem statement or a Q Business conversation. Provide the implementation with
`Effect.provide(AWS.QApps.PredictQAppHttp)`.
### Generation
**Example:** Generate an App Definition from a Prompt
```typescript
// init — bind the operation to the Q App
const predictQApp = yield* AWS.QApps.PredictQApp(app);

// runtime
const predicted = yield* predictQApp({
  options: {
    problemStatement: "Summarize meeting notes into action items",
  },
});
console.log(predicted.app.title);
```

@binding

## PredictQApp.Request

Request for {@link PredictQApp} — `instanceId` is injected from the bound Q App.

## StartQAppSession

Runtime binding for `qapps:StartQAppSession`.

Starts a new session of the bound Q App, optionally seeding initial card values. Provide the implementation with
`Effect.provide(AWS.QApps.StartQAppSessionHttp)`.
### Sessions
**Example:** Start a Session
```typescript
// init — bind the operation to the Q App
const startQAppSession = yield* AWS.QApps.StartQAppSession(app);

// runtime
const session = yield* startQAppSession({ appVersion: 1 });
console.log(session.sessionId);
```

@binding

## StartQAppSession.Request

Request for {@link StartQAppSession} — `instanceId` and `appId` are injected from the bound Q App.

## StopQAppSession

Runtime binding for `qapps:StopQAppSession`.

Stops an active Q App session, halting any in-progress card executions. Provide the implementation with
`Effect.provide(AWS.QApps.StopQAppSessionHttp)`.
### Sessions
**Example:** Stop a Session
```typescript
// init — bind the operation to the Q App
const stopQAppSession = yield* AWS.QApps.StopQAppSession(app);

// runtime
yield* stopQAppSession({ sessionId });
```

@binding

## StopQAppSession.Request

Request for {@link StopQAppSession} — `instanceId` is injected from the bound Q App.

## UpdateLibraryItem

Runtime binding for `qapps:UpdateLibraryItem`.

Updates a library item's publication status or categories. Provide the implementation with
`Effect.provide(AWS.QApps.UpdateLibraryItemHttp)`.
### Library Items
**Example:** Disable a Library Item
```typescript
// init — bind the operation to the Q App
const updateLibraryItem = yield* AWS.QApps.UpdateLibraryItem(app);

// runtime
yield* updateLibraryItem({ libraryItemId, status: "DISABLED" });
```

@binding

## UpdateLibraryItem.Request

Request for {@link UpdateLibraryItem} — `instanceId` is injected from the bound Q App.

## UpdateLibraryItemMetadata

Runtime binding for `qapps:UpdateLibraryItemMetadata`.

Updates a library item's verification badge (`isVerified`). Provide the implementation with
`Effect.provide(AWS.QApps.UpdateLibraryItemMetadataHttp)`.
### Library Items
**Example:** Mark a Library Item Verified
```typescript
// init — bind the operation to the Q App
const updateLibraryItemMetadata = yield* AWS.QApps.UpdateLibraryItemMetadata(app);

// runtime
yield* updateLibraryItemMetadata({ libraryItemId, isVerified: true });
```

@binding

## UpdateLibraryItemMetadata.Request

Request for {@link UpdateLibraryItemMetadata} — `instanceId` is injected from the bound Q App.

## UpdateQAppPermissions

Runtime binding for `qapps:UpdateQAppPermissions`.

Grants or revokes read/edit permissions on the bound Q App for Identity Center principals. Provide the implementation with
`Effect.provide(AWS.QApps.UpdateQAppPermissionsHttp)`.
### Permissions
**Example:** Grant Read Access
```typescript
// init — bind the operation to the Q App
const updateQAppPermissions = yield* AWS.QApps.UpdateQAppPermissions(app);

// runtime
yield* updateQAppPermissions({
  grantPermissions: [{ action: "read", principal: userId }],
});
```

@binding

## UpdateQAppPermissions.Request

Request for {@link UpdateQAppPermissions} — `instanceId` and `appId` are injected from the bound Q App.

## UpdateQAppSession

Runtime binding for `qapps:UpdateQAppSession`.

Submits new card values into a running Q App session (e.g. answers a text-input card). Provide the implementation with
`Effect.provide(AWS.QApps.UpdateQAppSessionHttp)`.
### Sessions
**Example:** Submit Card Values
```typescript
// init — bind the operation to the Q App
const updateQAppSession = yield* AWS.QApps.UpdateQAppSession(app);

// runtime
yield* updateQAppSession({
  sessionId,
  values: [{ cardId, value: "Hello, Q Apps!" }],
});
```

@binding

## UpdateQAppSession.Request

Request for {@link UpdateQAppSession} — `instanceId` is injected from the bound Q App.

## UpdateQAppSessionMetadata

Runtime binding for `qapps:UpdateQAppSessionMetadata`.

Updates a Q App session's metadata — rename it or reconfigure how it is shared with collaborators. Provide the implementation with
`Effect.provide(AWS.QApps.UpdateQAppSessionMetadataHttp)`.
### Sessions
**Example:** Share a Session
```typescript
// init — bind the operation to the Q App
const updateQAppSessionMetadata = yield* AWS.QApps.UpdateQAppSessionMetadata(app);

// runtime
yield* updateQAppSessionMetadata({
  sessionId,
  sharingConfiguration: { enabled: true, acceptResponses: true },
});
```

@binding

## UpdateQAppSessionMetadata.Request

Request for {@link UpdateQAppSessionMetadata} — `instanceId` is injected from the bound Q App.
