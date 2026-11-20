<!-- Docs for the generated AWS.QBusiness bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## AssociatePermission

Runtime binding for the `AssociatePermission` operation (IAM action
`qbusiness:AssociatePermission`), scoped to one {@link Application}.

Adds a statement to the application's permission policy, granting
a principal (e.g. an ISV data accessor) cross-account access to Q
Business actions.
Provide the implementation with
`Effect.provide(AWS.QBusiness.AssociatePermissionHttp)`.

### Cross-Account Permissions
**Example:** Grant an ISV SearchRelevantContent
```typescript
const associate = yield* AWS.QBusiness.AssociatePermission(app);

yield* associate({
  statementId: "isv-search",
  actions: ["qbusiness:SearchRelevantContent"],
  principal: "arn:aws:iam::123456789012:role/IsvRole",
});
```

@binding

## AssociatePermission.Request

`AssociatePermission` request with `applicationId` injected from the bound application.

## BatchDeleteDocument

Runtime binding for the `BatchDeleteDocument` operation (IAM action
`qbusiness:BatchDeleteDocument`), scoped to one {@link Index}.

Removes documents from the index by document id.
Provide the implementation with
`Effect.provide(AWS.QBusiness.BatchDeleteDocumentHttp)`.

### Document Ingestion
**Example:** Delete Documents from an Index
```typescript
const deleteDocuments = yield* AWS.QBusiness.BatchDeleteDocument(index);

yield* deleteDocuments({ documents: [{ documentId: "welcome" }] });
```

@binding

## BatchDeleteDocument.Request

`BatchDeleteDocument` request with `applicationId` + `indexId` injected from the bound index.

## BatchPutDocument

Runtime binding for the `BatchPutDocument` operation (IAM action
`qbusiness:BatchPutDocument`), scoped to one {@link Index}.

Adds or updates documents in the index directly (the CUSTOM data
source path), with optional access controls and enrichment.
Provide the implementation with
`Effect.provide(AWS.QBusiness.BatchPutDocumentHttp)`.

### Document Ingestion
**Example:** Push Documents into an Index
```typescript
const putDocuments = yield* AWS.QBusiness.BatchPutDocument(index);

const { failedDocuments } = yield* putDocuments({
  documents: [
    {
      id: "welcome",
      title: "Welcome",
      content: { blob: new TextEncoder().encode("Hello Q!") },
      contentType: "PLAIN_TEXT",
    },
  ],
});
```

@binding

## BatchPutDocument.Request

`BatchPutDocument` request with `applicationId` + `indexId` injected from the bound index.

## CancelSubscription

Runtime binding for the `CancelSubscription` operation (IAM action
`qbusiness:CancelSubscription`), scoped to one {@link Application}.

Unsubscribes a user or group; the change takes effect at the next
month boundary.
Provide the implementation with
`Effect.provide(AWS.QBusiness.CancelSubscriptionHttp)`.

### Subscriptions
**Example:** Cancel a Subscription
```typescript
const cancel = yield* AWS.QBusiness.CancelSubscription(app);

yield* cancel({ subscriptionId });
```

@binding

## CancelSubscription.Request

`CancelSubscription` request with `applicationId` injected from the bound application.

## ChatSync

Runtime binding for the `ChatSync` operation (IAM action
`qbusiness:ChatSync`), scoped to one {@link Application}.

Sends a user message to the application and returns the full
AI-generated answer in one response, including source attributions
and any suggested plugin actions.
Provide the implementation with
`Effect.provide(AWS.QBusiness.ChatSyncHttp)`.

### Chat
**Example:** Ask a Question
```typescript
const chat = yield* AWS.QBusiness.ChatSync(app);

const reply = yield* chat({ userMessage: "What is our travel policy?" });
console.log(reply.systemMessage);
```

@binding

## ChatSync.Request

`ChatSync` request with `applicationId` injected from the bound application.

## CheckDocumentAccess

Runtime binding for the `CheckDocumentAccess` operation (IAM action
`qbusiness:CheckDocumentAccess`), scoped to one {@link Index}.

Checks whether a specific user can access a document, returning
the user's groups/aliases and the document's ACL evaluation.
Provide the implementation with
`Effect.provide(AWS.QBusiness.CheckDocumentAccessHttp)`.

### Document Ingestion
**Example:** Check a User's Document Access
```typescript
const checkAccess = yield* AWS.QBusiness.CheckDocumentAccess(index);

const { hasAccess } = yield* checkAccess({
  userId: "user@example.com",
  documentId: "welcome",
});
```

@binding

## CheckDocumentAccess.Request

`CheckDocumentAccess` request with `applicationId` + `indexId` injected from the bound index.

## CreateSubscription

Runtime binding for the `CreateSubscription` operation (IAM action
`qbusiness:CreateSubscription`), scoped to one {@link Application}.

Subscribes an IAM Identity Center user or group to a Q Business
pricing tier (`Q_LITE` or `Q_BUSINESS`).
Provide the implementation with
`Effect.provide(AWS.QBusiness.CreateSubscriptionHttp)`.

### Subscriptions
**Example:** Subscribe a User
```typescript
const subscribe = yield* AWS.QBusiness.CreateSubscription(app);

yield* subscribe({
  principal: { user: idcUserId },
  type: "Q_BUSINESS",
});
```

@binding

## CreateSubscription.Request

`CreateSubscription` request with `applicationId` injected from the bound application.

## CreateUser

Runtime binding for the `CreateUser` operation (IAM action
`qbusiness:CreateUser`), scoped to one {@link Application}.

Creates a user in the application's user store, mapping the user
id to data-source-specific aliases used for document access
control.
Provide the implementation with
`Effect.provide(AWS.QBusiness.CreateUserHttp)`.

### User Management
**Example:** Create a User with Aliases
```typescript
const createUser = yield* AWS.QBusiness.CreateUser(app);

yield* createUser({
  userId: "user@example.com",
  userAliases: [{ userId: "corp\\user" }],
});
```

@binding

## CreateUser.Request

`CreateUser` request with `applicationId` injected from the bound application.

## DeleteAttachment

Runtime binding for the `DeleteAttachment` operation (IAM action
`qbusiness:DeleteAttachment`), scoped to one {@link Application}.

Deletes an attachment associated with a chat conversation.
Provide the implementation with
`Effect.provide(AWS.QBusiness.DeleteAttachmentHttp)`.

### Conversations
**Example:** Delete an Attachment
```typescript
const deleteAttachment = yield* AWS.QBusiness.DeleteAttachment(app);

yield* deleteAttachment({ conversationId, attachmentId });
```

@binding

## DeleteAttachment.Request

`DeleteAttachment` request with `applicationId` injected from the bound application.

## DeleteChatControlsConfiguration

Runtime binding for the `DeleteChatControlsConfiguration` operation (IAM action
`qbusiness:DeleteChatControlsConfiguration`), scoped to one {@link Application}.

Deletes the application's chat controls configuration.
Provide the implementation with
`Effect.provide(AWS.QBusiness.DeleteChatControlsConfigurationHttp)`.

### Admin Controls
**Example:** Delete Chat Controls
```typescript
const deleteControls =
  yield* AWS.QBusiness.DeleteChatControlsConfiguration(app);

yield* deleteControls();
```

@binding

## DeleteChatControlsConfiguration.Request

`DeleteChatControlsConfiguration` request with `applicationId` injected from the bound application.

## DeleteConversation

Runtime binding for the `DeleteConversation` operation (IAM action
`qbusiness:DeleteConversation`), scoped to one {@link Application}.

Deletes a chat conversation and its messages.
Provide the implementation with
`Effect.provide(AWS.QBusiness.DeleteConversationHttp)`.

### Conversations
**Example:** Delete a Conversation
```typescript
const deleteConversation = yield* AWS.QBusiness.DeleteConversation(app);

yield* deleteConversation({ conversationId });
```

@binding

## DeleteConversation.Request

`DeleteConversation` request with `applicationId` injected from the bound application.

## DeleteGroup

Runtime binding for the `DeleteGroup` operation (IAM action
`qbusiness:DeleteGroup`), scoped to one {@link Index}.

Deletes a mapped group so its members lose group-scoped document
access on the next query.
Provide the implementation with
`Effect.provide(AWS.QBusiness.DeleteGroupHttp)`.

### Principal Mapping
**Example:** Delete a Group Mapping
```typescript
const deleteGroup = yield* AWS.QBusiness.DeleteGroup(index);

yield* deleteGroup({ groupName: "engineering" });
```

@binding

## DeleteGroup.Request

`DeleteGroup` request with `applicationId` + `indexId` injected from the bound index.

## DeleteUser

Runtime binding for the `DeleteUser` operation (IAM action
`qbusiness:DeleteUser`), scoped to one {@link Application}.

Deletes a user from the application user store.
Provide the implementation with
`Effect.provide(AWS.QBusiness.DeleteUserHttp)`.

### User Management
**Example:** Delete a User
```typescript
const deleteUser = yield* AWS.QBusiness.DeleteUser(app);

yield* deleteUser({ userId: "user@example.com" });
```

@binding

## DeleteUser.Request

`DeleteUser` request with `applicationId` injected from the bound application.

## DisassociatePermission

Runtime binding for the `DisassociatePermission` operation (IAM action
`qbusiness:DisassociatePermission`), scoped to one {@link Application}.

Removes a statement from the application's permission policy.
Provide the implementation with
`Effect.provide(AWS.QBusiness.DisassociatePermissionHttp)`.

### Cross-Account Permissions
**Example:** Revoke a Permission Statement
```typescript
const disassociate = yield* AWS.QBusiness.DisassociatePermission(app);

yield* disassociate({ statementId: "isv-search" });
```

@binding

## DisassociatePermission.Request

`DisassociatePermission` request with `applicationId` injected from the bound application.

## GetChatControlsConfiguration

Runtime binding for the `GetChatControlsConfiguration` operation (IAM action
`qbusiness:GetChatControlsConfiguration`), scoped to one {@link Application}.

Reads the application's chat controls: response scope, blocked
phrases, topic rules, and creator mode.
Provide the implementation with
`Effect.provide(AWS.QBusiness.GetChatControlsConfigurationHttp)`.

### Admin Controls
**Example:** Read Chat Controls
```typescript
const getControls = yield* AWS.QBusiness.GetChatControlsConfiguration(app);

const { responseScope, blockedPhrases } = yield* getControls();
```

@binding

## GetChatControlsConfiguration.Request

`GetChatControlsConfiguration` request with `applicationId` injected from the bound application.

## GetDocumentContent

Runtime binding for the `GetDocumentContent` operation (IAM action
`qbusiness:GetDocumentContent`), scoped to one {@link Index}.

Returns a presigned URL for an indexed document's content, in the
raw uploaded format or the extracted text.
Provide the implementation with
`Effect.provide(AWS.QBusiness.GetDocumentContentHttp)`.

### Document Ingestion
**Example:** Fetch a Document's Content
```typescript
const getContent = yield* AWS.QBusiness.GetDocumentContent(index);

const { presignedUrl } = yield* getContent({ documentId: "welcome" });
```

@binding

## GetDocumentContent.Request

`GetDocumentContent` request with `applicationId` + `indexId` injected from the bound index.

## GetGroup

Runtime binding for the `GetGroup` operation (IAM action
`qbusiness:GetGroup`), scoped to one {@link Index}.

Reads a mapped group's processing status.
Provide the implementation with
`Effect.provide(AWS.QBusiness.GetGroupHttp)`.

### Principal Mapping
**Example:** Read a Group's Status
```typescript
const getGroup = yield* AWS.QBusiness.GetGroup(index);

const { status } = yield* getGroup({ groupName: "engineering" });
```

@binding

## GetGroup.Request

`GetGroup` request with `applicationId` + `indexId` injected from the bound index.

## GetMedia

Runtime binding for the `GetMedia` operation (IAM action
`qbusiness:GetMedia`), scoped to one {@link Application}.

Fetches the media object (e.g. an extracted image) associated with
a chat message.
Provide the implementation with
`Effect.provide(AWS.QBusiness.GetMediaHttp)`.

### Conversations
**Example:** Fetch Message Media
```typescript
const getMedia = yield* AWS.QBusiness.GetMedia(app);

const media = yield* getMedia({ conversationId, messageId, mediaId });
```

@binding

## GetMedia.Request

`GetMedia` request with `applicationId` injected from the bound application.

## GetPolicy

Runtime binding for the `GetPolicy` operation (IAM action
`qbusiness:GetPolicy`), scoped to one {@link Application}.

Reads the application's resource-based permission policy (the
statements ISV data accessors were granted).
Provide the implementation with
`Effect.provide(AWS.QBusiness.GetPolicyHttp)`.

### Cross-Account Permissions
**Example:** Read the Application Policy
```typescript
const getPolicy = yield* AWS.QBusiness.GetPolicy(app);

const { policy } = yield* getPolicy();
```

@binding

## GetPolicy.Request

`GetPolicy` request with `applicationId` injected from the bound application.

## GetUser

Runtime binding for the `GetUser` operation (IAM action
`qbusiness:GetUser`), scoped to one {@link Application}.

Reads a user's alias mappings from the application user store.
Provide the implementation with
`Effect.provide(AWS.QBusiness.GetUserHttp)`.

### User Management
**Example:** Read a User
```typescript
const getUser = yield* AWS.QBusiness.GetUser(app);

const { userAliases } = yield* getUser({ userId: "user@example.com" });
```

@binding

## GetUser.Request

`GetUser` request with `applicationId` injected from the bound application.

## ListAttachments

Runtime binding for the `ListAttachments` operation (IAM action
`qbusiness:ListAttachments`), scoped to one {@link Application}.

Lists the files attached to chat conversations.
Provide the implementation with
`Effect.provide(AWS.QBusiness.ListAttachmentsHttp)`.

### Conversations
**Example:** List Attachments
```typescript
const listAttachments = yield* AWS.QBusiness.ListAttachments(app);

const { attachments } = yield* listAttachments({ conversationId });
```

@binding

## ListAttachments.Request

`ListAttachments` request with `applicationId` injected from the bound application.

## ListConversations

Runtime binding for the `ListConversations` operation (IAM action
`qbusiness:ListConversations`), scoped to one {@link Application}.

Lists a user's chat conversations in the application.
Provide the implementation with
`Effect.provide(AWS.QBusiness.ListConversationsHttp)`.

### Conversations
**Example:** List Conversations
```typescript
const listConversations = yield* AWS.QBusiness.ListConversations(app);

const { conversations } = yield* listConversations();
```

@binding

## ListConversations.Request

`ListConversations` request with `applicationId` injected from the bound application.

## ListDataSourceSyncJobs

Runtime binding for the `ListDataSourceSyncJobs` operation (IAM action
`qbusiness:ListDataSourceSyncJobs`), scoped to one {@link DataSource}.

Lists the data source's synchronization job history.
Provide the implementation with
`Effect.provide(AWS.QBusiness.ListDataSourceSyncJobsHttp)`.

### Data Source Sync
**Example:** List Sync Job History
```typescript
const listSyncJobs = yield* AWS.QBusiness.ListDataSourceSyncJobs(source);

const { history } = yield* listSyncJobs();
```

@binding

## ListDataSourceSyncJobs.Request

`ListDataSourceSyncJobs` request with `applicationId` + `indexId` + `dataSourceId` injected from the bound data source.

## ListDocuments

Runtime binding for the `ListDocuments` operation (IAM action
`qbusiness:ListDocuments`), scoped to one {@link Index}.

Lists the documents the index holds and their ingestion status.
Provide the implementation with
`Effect.provide(AWS.QBusiness.ListDocumentsHttp)`.

### Document Ingestion
**Example:** List Indexed Documents
```typescript
const listDocuments = yield* AWS.QBusiness.ListDocuments(index);

const { documentDetailList } = yield* listDocuments();
```

@binding

## ListDocuments.Request

`ListDocuments` request with `applicationId` + `indexId` injected from the bound index.

## ListGroups

Runtime binding for the `ListGroups` operation (IAM action
`qbusiness:ListGroups`), scoped to one {@link Index}.

Lists the groups mapped into the index before a given time.
Provide the implementation with
`Effect.provide(AWS.QBusiness.ListGroupsHttp)`.

### Principal Mapping
**Example:** List Mapped Groups
```typescript
const listGroups = yield* AWS.QBusiness.ListGroups(index);

const { items } = yield* listGroups({ updatedEarlierThan: new Date() });
```

@binding

## ListGroups.Request

`ListGroups` request with `applicationId` + `indexId` injected from the bound index.

## ListMessages

Runtime binding for the `ListMessages` operation (IAM action
`qbusiness:ListMessages`), scoped to one {@link Application}.

Lists the messages of a chat conversation.
Provide the implementation with
`Effect.provide(AWS.QBusiness.ListMessagesHttp)`.

### Conversations
**Example:** List a Conversation's Messages
```typescript
const listMessages = yield* AWS.QBusiness.ListMessages(app);

const { messages } = yield* listMessages({ conversationId });
```

@binding

## ListMessages.Request

`ListMessages` request with `applicationId` injected from the bound application.

## ListSubscriptions

Runtime binding for the `ListSubscriptions` operation (IAM action
`qbusiness:ListSubscriptions`), scoped to one {@link Application}.

Lists the application's user and group subscriptions.
Provide the implementation with
`Effect.provide(AWS.QBusiness.ListSubscriptionsHttp)`.

### Subscriptions
**Example:** List Subscriptions
```typescript
const listSubscriptions = yield* AWS.QBusiness.ListSubscriptions(app);

const { subscriptions } = yield* listSubscriptions();
```

@binding

## ListSubscriptions.Request

`ListSubscriptions` request with `applicationId` injected from the bound application.

## PutFeedback

Runtime binding for the `PutFeedback` operation (IAM action
`qbusiness:PutFeedback`), scoped to one {@link Application}.

Records end-user usefulness feedback (thumbs up/down and reasons)
for a chat message, which Amazon Q Business uses to improve
response quality.
Provide the implementation with
`Effect.provide(AWS.QBusiness.PutFeedbackHttp)`.

### Chat
**Example:** Submit Feedback for a Message
```typescript
const feedback = yield* AWS.QBusiness.PutFeedback(app);

yield* feedback({
  conversationId: reply.conversationId!,
  messageId: reply.systemMessageId!,
  messageUsefulness: {
    usefulness: "USEFUL",
    submittedAt: new Date(),
  },
});
```

@binding

## PutFeedback.Request

`PutFeedback` request with `applicationId` injected from the bound application.

## PutGroup

Runtime binding for the `PutGroup` operation (IAM action
`qbusiness:PutGroup`), scoped to one {@link Index}.

Creates or replaces a group's membership (users and sub groups)
used to enforce document access control at query time.
Provide the implementation with
`Effect.provide(AWS.QBusiness.PutGroupHttp)`.

### Principal Mapping
**Example:** Map a Group's Members
```typescript
const putGroup = yield* AWS.QBusiness.PutGroup(index);

yield* putGroup({
  groupName: "engineering",
  type: "INDEX",
  groupMembers: {
    memberUsers: [{ userId: "user@example.com", type: "INDEX" }],
  },
});
```

@binding

## PutGroup.Request

`PutGroup` request with `applicationId` + `indexId` injected from the bound index.

## SearchRelevantContent

Runtime binding for the `SearchRelevantContent` operation (IAM action
`qbusiness:SearchRelevantContent`), scoped to one {@link Application}.

Searches an application's indexed content through a retriever and
returns the relevant passages without generating an answer — the
RAG retrieval half on its own.
Provide the implementation with
`Effect.provide(AWS.QBusiness.SearchRelevantContentHttp)`.

### Content Retrieval
**Example:** Retrieve Relevant Passages
```typescript
const search = yield* AWS.QBusiness.SearchRelevantContent(app);

const results = yield* search({
  queryText: "expense reimbursement deadline",
  contentSource: { retriever: { retrieverId: retriever.retrieverId } },
});
```

@binding

## SearchRelevantContent.Request

`SearchRelevantContent` request with `applicationId` injected from the bound application.

## StartDataSourceSyncJob

Runtime binding for the `StartDataSourceSyncJob` operation (IAM action
`qbusiness:StartDataSourceSyncJob`), scoped to one {@link DataSource}.

Starts a synchronization job that crawls the connector and ingests
its content into the index.
Provide the implementation with
`Effect.provide(AWS.QBusiness.StartDataSourceSyncJobHttp)`.

### Data Source Sync
**Example:** Start a Sync Job
```typescript
const startSync = yield* AWS.QBusiness.StartDataSourceSyncJob(source);

const { executionId } = yield* startSync();
```

@binding

## StartDataSourceSyncJob.Request

`StartDataSourceSyncJob` request with `applicationId` + `indexId` + `dataSourceId` injected from the bound data source.

## StopDataSourceSyncJob

Runtime binding for the `StopDataSourceSyncJob` operation (IAM action
`qbusiness:StopDataSourceSyncJob`), scoped to one {@link DataSource}.

Stops the data source's running synchronization job.
Provide the implementation with
`Effect.provide(AWS.QBusiness.StopDataSourceSyncJobHttp)`.

### Data Source Sync
**Example:** Stop the Running Sync Job
```typescript
const stopSync = yield* AWS.QBusiness.StopDataSourceSyncJob(source);

yield* stopSync();
```

@binding

## StopDataSourceSyncJob.Request

`StopDataSourceSyncJob` request with `applicationId` + `indexId` + `dataSourceId` injected from the bound data source.

## UpdateChatControlsConfiguration

Runtime binding for the `UpdateChatControlsConfiguration` operation (IAM action
`qbusiness:UpdateChatControlsConfiguration`), scoped to one {@link Application}.

Updates the application's chat controls — response scope, blocked
phrases, topic rules, creator mode, and hallucination reduction.
Provide the implementation with
`Effect.provide(AWS.QBusiness.UpdateChatControlsConfigurationHttp)`.

### Admin Controls
**Example:** Restrict Responses to Enterprise Content
```typescript
const updateControls =
  yield* AWS.QBusiness.UpdateChatControlsConfiguration(app);

yield* updateControls({ responseScope: "ENTERPRISE_CONTENT_ONLY" });
```

@binding

## UpdateChatControlsConfiguration.Request

`UpdateChatControlsConfiguration` request with `applicationId` injected from the bound application.

## UpdateSubscription

Runtime binding for the `UpdateSubscription` operation (IAM action
`qbusiness:UpdateSubscription`), scoped to one {@link Application}.

Changes an existing subscription's pricing tier.
Provide the implementation with
`Effect.provide(AWS.QBusiness.UpdateSubscriptionHttp)`.

### Subscriptions
**Example:** Change a Subscription Tier
```typescript
const updateSubscription = yield* AWS.QBusiness.UpdateSubscription(app);

yield* updateSubscription({ subscriptionId, type: "Q_LITE" });
```

@binding

## UpdateSubscription.Request

`UpdateSubscription` request with `applicationId` injected from the bound application.

## UpdateUser

Runtime binding for the `UpdateUser` operation (IAM action
`qbusiness:UpdateUser`), scoped to one {@link Application}.

Adds and removes alias mappings for a user.
Provide the implementation with
`Effect.provide(AWS.QBusiness.UpdateUserHttp)`.

### User Management
**Example:** Update a User's Aliases
```typescript
const updateUser = yield* AWS.QBusiness.UpdateUser(app);

yield* updateUser({
  userId: "user@example.com",
  userAliasesToUpdate: [{ userId: "corp\\user" }],
});
```

@binding

## UpdateUser.Request

`UpdateUser` request with `applicationId` injected from the bound application.
