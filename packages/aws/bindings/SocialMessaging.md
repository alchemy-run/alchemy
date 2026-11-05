<!-- Docs for the generated AWS.SocialMessaging bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## CreateWhatsAppFlow

Runtime binding for `social-messaging:CreateWhatsAppFlow`.

Creates a WhatsApp Flow (a rich interactive form users complete inside
WhatsApp) on the bound account, in DRAFT status unless `publish` is set
with a valid `flowJson`.

The deploy-time half grants `social-messaging:CreateWhatsAppFlow` on the
bound WABA's ARN and the runtime half injects the linked account id
into every request.
Provide the implementation with
`Effect.provide(AWS.SocialMessaging.CreateWhatsAppFlowHttp)`.
### Managing WhatsApp Flows
**Example:** Create a Flow
```typescript
// init — bind the operation to the linked WABA
const createFlow = yield* AWS.SocialMessaging.CreateWhatsAppFlow(account);

// runtime
const { flowId, validationErrors } = yield* createFlow({
  flowName: "appointment-booking",
  categories: ["APPOINTMENT_BOOKING"],
});
```

@binding

## CreateWhatsAppFlow.Request

Request for {@link CreateWhatsAppFlow}. The linked WABA `id` is injected by
the binding from the bound {@link LinkedWhatsAppBusinessAccount}.

## CreateWhatsAppMessageTemplate

Runtime binding for `social-messaging:CreateWhatsAppMessageTemplate`.

Creates a WhatsApp message template on the bound account from a raw Meta
template-definition JSON blob. Templates must be approved by Meta before
they can be sent.

The deploy-time half grants `social-messaging:CreateWhatsAppMessageTemplate` on the
bound WABA's ARN and the runtime half injects the linked account id
into every request.
Provide the implementation with
`Effect.provide(AWS.SocialMessaging.CreateWhatsAppMessageTemplateHttp)`.
### Managing Message Templates
**Example:** Create a Template from a Definition
```typescript
// init — bind the operation to the linked WABA
const createTemplate = yield* AWS.SocialMessaging.CreateWhatsAppMessageTemplate(account);

// runtime
const { metaTemplateId, templateStatus } = yield* createTemplate({
  templateDefinition: new TextEncoder().encode(
    JSON.stringify({
      name: "order_update",
      language: "en_US",
      category: "UTILITY",
      components: [{ type: "BODY", text: "Your order {{1}} shipped." }],
    }),
  ),
});
```

@binding

## CreateWhatsAppMessageTemplate.Request

Request for {@link CreateWhatsAppMessageTemplate}. The linked WABA `id` is injected by
the binding from the bound {@link LinkedWhatsAppBusinessAccount}.

## CreateWhatsAppMessageTemplateMedia

Runtime binding for `social-messaging:CreateWhatsAppMessageTemplateMedia`.

Uploads media (from S3) for use in a WhatsApp message template header and
returns the Meta header handle to reference from the template definition.

The deploy-time half grants `social-messaging:CreateWhatsAppMessageTemplateMedia` on the
bound WABA's ARN and the runtime half injects the linked account id
into every request.
Provide the implementation with
`Effect.provide(AWS.SocialMessaging.CreateWhatsAppMessageTemplateMediaHttp)`.
### Managing Message Templates
**Example:** Upload Template Header Media
```typescript
// init — bind the operation to the linked WABA
const uploadTemplateMedia = yield* AWS.SocialMessaging.CreateWhatsAppMessageTemplateMedia(account);

// runtime
const { metaHeaderHandle } = yield* uploadTemplateMedia({
  sourceS3File: { bucketName: "my-assets", key: "header.png" },
});
```

@binding

## CreateWhatsAppMessageTemplateMedia.Request

Request for {@link CreateWhatsAppMessageTemplateMedia}. The linked WABA `id` is injected by
the binding from the bound {@link LinkedWhatsAppBusinessAccount}.

## DeleteWhatsAppFlow

Runtime binding for `social-messaging:DeleteWhatsAppFlow`.

Deletes a DRAFT WhatsApp Flow from the bound account. Published flows
must be deprecated instead.

The deploy-time half grants `social-messaging:DeleteWhatsAppFlow` on the
bound WABA's ARN and the runtime half injects the linked account id
into every request.
Provide the implementation with
`Effect.provide(AWS.SocialMessaging.DeleteWhatsAppFlowHttp)`.
### Managing WhatsApp Flows
**Example:** Delete a Flow
```typescript
// init — bind the operation to the linked WABA
const deleteFlow = yield* AWS.SocialMessaging.DeleteWhatsAppFlow(account);

// runtime
yield* deleteFlow({ flowId: "1234567890" });
```

@binding

## DeleteWhatsAppFlow.Request

Request for {@link DeleteWhatsAppFlow}. The linked WABA `id` is injected by
the binding from the bound {@link LinkedWhatsAppBusinessAccount}.

## DeleteWhatsAppMessageMedia

Runtime binding for `social-messaging:DeleteWhatsAppMessageMedia`.

Deletes a media file previously uploaded to WhatsApp from the given phone
number.

The caller addresses one of the bound account's phone numbers per
request; phone-number ARNs are provisioned by Meta under the WABA, so
the deploy-time half grants `social-messaging:DeleteWhatsAppMessageMedia` on `*`.
Provide the implementation with
`Effect.provide(AWS.SocialMessaging.DeleteWhatsAppMessageMediaHttp)`.
### Managing Message Media
**Example:** Delete Uploaded Media
```typescript
// init — bind the operation to the linked WABA
const deleteMedia = yield* AWS.SocialMessaging.DeleteWhatsAppMessageMedia(account);

// runtime
const { success } = yield* deleteMedia({
  mediaId: "media-id-to-delete",
  originationPhoneNumberId: "phone-number-id-0123456789abcdef",
});
```

@binding

## DeleteWhatsAppMessageTemplate

Runtime binding for `social-messaging:DeleteWhatsAppMessageTemplate`.

Deletes a WhatsApp message template from the bound account, optionally
across all of its languages.

The deploy-time half grants `social-messaging:DeleteWhatsAppMessageTemplate` on the
bound WABA's ARN and the runtime half injects the linked account id
into every request.
Provide the implementation with
`Effect.provide(AWS.SocialMessaging.DeleteWhatsAppMessageTemplateHttp)`.
### Managing Message Templates
**Example:** Delete a Template
```typescript
// init — bind the operation to the linked WABA
const deleteTemplate = yield* AWS.SocialMessaging.DeleteWhatsAppMessageTemplate(account);

// runtime
yield* deleteTemplate({
  templateName: "order_update",
  deleteAllLanguages: true,
});
```

@binding

## DeleteWhatsAppMessageTemplate.Request

Request for {@link DeleteWhatsAppMessageTemplate}. The linked WABA `id` is injected by
the binding from the bound {@link LinkedWhatsAppBusinessAccount}.

## DeprecateWhatsAppFlow

Runtime binding for `social-messaging:DeprecateWhatsAppFlow`.

Deprecates a published WhatsApp Flow on the bound account so it can no
longer be sent to users.

The deploy-time half grants `social-messaging:DeprecateWhatsAppFlow` on the
bound WABA's ARN and the runtime half injects the linked account id
into every request.
Provide the implementation with
`Effect.provide(AWS.SocialMessaging.DeprecateWhatsAppFlowHttp)`.
### Managing WhatsApp Flows
**Example:** Deprecate a Flow
```typescript
// init — bind the operation to the linked WABA
const deprecateFlow = yield* AWS.SocialMessaging.DeprecateWhatsAppFlow(account);

// runtime
yield* deprecateFlow({ flowId: "1234567890" });
```

@binding

## DeprecateWhatsAppFlow.Request

Request for {@link DeprecateWhatsAppFlow}. The linked WABA `id` is injected by
the binding from the bound {@link LinkedWhatsAppBusinessAccount}.

## GetLinkedWhatsAppBusinessAccountPhoneNumber

Runtime binding for `social-messaging:GetLinkedWhatsAppBusinessAccountPhoneNumber`.

Retrieves the details (display name, quality rating, Meta ids) of one of
the linked account's WhatsApp phone numbers, plus the owning WABA id.

The caller addresses one of the bound account's phone numbers per
request; phone-number ARNs are provisioned by Meta under the WABA, so
the deploy-time half grants `social-messaging:GetLinkedWhatsAppBusinessAccountPhoneNumber` on `*`.
Provide the implementation with
`Effect.provide(AWS.SocialMessaging.GetLinkedWhatsAppBusinessAccountPhoneNumberHttp)`.
### Reading Phone Numbers
**Example:** Read Phone Number Details
```typescript
// init — bind the operation to the linked WABA
const getPhoneNumber = yield* AWS.SocialMessaging.GetLinkedWhatsAppBusinessAccountPhoneNumber(account);

// runtime
const details = yield* getPhoneNumber({
  id: "phone-number-id-0123456789abcdef",
});
const rating = details.phoneNumber?.qualityRating;
```

@binding

## GetWhatsAppFlow

Runtime binding for `social-messaging:GetWhatsAppFlow`.

Retrieves a WhatsApp Flow's details — status, categories, validation
errors, health status — from the bound account.

The deploy-time half grants `social-messaging:GetWhatsAppFlow` on the
bound WABA's ARN and the runtime half injects the linked account id
into every request.
Provide the implementation with
`Effect.provide(AWS.SocialMessaging.GetWhatsAppFlowHttp)`.
### Managing WhatsApp Flows
**Example:** Read a Flow
```typescript
// init — bind the operation to the linked WABA
const getFlow = yield* AWS.SocialMessaging.GetWhatsAppFlow(account);

// runtime
const flow = yield* getFlow({ flowId: "1234567890" });
const publishable = flow.validationErrors?.length === 0;
```

@binding

## GetWhatsAppFlow.Request

Request for {@link GetWhatsAppFlow}. The linked WABA `id` is injected by
the binding from the bound {@link LinkedWhatsAppBusinessAccount}.

## GetWhatsAppFlowPreview

Runtime binding for `social-messaging:GetWhatsAppFlowPreview`.

Generates (or refreshes with `invalidate`) a shareable preview URL for a
WhatsApp Flow on the bound account.

The deploy-time half grants `social-messaging:GetWhatsAppFlowPreview` on the
bound WABA's ARN and the runtime half injects the linked account id
into every request.
Provide the implementation with
`Effect.provide(AWS.SocialMessaging.GetWhatsAppFlowPreviewHttp)`.
### Managing WhatsApp Flows
**Example:** Get a Flow Preview URL
```typescript
// init — bind the operation to the linked WABA
const getFlowPreview = yield* AWS.SocialMessaging.GetWhatsAppFlowPreview(account);

// runtime
const { preview } = yield* getFlowPreview({
  flowId: "1234567890",
  invalidate: true,
});
```

@binding

## GetWhatsAppFlowPreview.Request

Request for {@link GetWhatsAppFlowPreview}. The linked WABA `id` is injected by
the binding from the bound {@link LinkedWhatsAppBusinessAccount}.

## GetWhatsAppMessageMedia

Runtime binding for `social-messaging:GetWhatsAppMessageMedia`.

Retrieves a media file received in a WhatsApp message — either just its
metadata (`metadataOnly: true`) or a full download into an S3 object or
presigned URL.

The caller addresses one of the bound account's phone numbers per
request; phone-number ARNs are provisioned by Meta under the WABA, so
the deploy-time half grants `social-messaging:GetWhatsAppMessageMedia` on `*`.
Provide the implementation with
`Effect.provide(AWS.SocialMessaging.GetWhatsAppMessageMediaHttp)`.
### Managing Message Media
**Example:** Download Received Media to S3
```typescript
// init — bind the operation to the linked WABA
const getMedia = yield* AWS.SocialMessaging.GetWhatsAppMessageMedia(account);

// runtime
const { mimeType, fileSize } = yield* getMedia({
  mediaId: "media-id-from-inbound-event",
  originationPhoneNumberId: "phone-number-id-0123456789abcdef",
  destinationS3File: { bucketName: "my-inbox", key: "media/inbound" },
});
```

@binding

## GetWhatsAppMessageTemplate

Runtime binding for `social-messaging:GetWhatsAppMessageTemplate`.

Retrieves a WhatsApp message template's JSON definition from the bound
account by its Meta template id.

The deploy-time half grants `social-messaging:GetWhatsAppMessageTemplate` on the
bound WABA's ARN and the runtime half injects the linked account id
into every request.
Provide the implementation with
`Effect.provide(AWS.SocialMessaging.GetWhatsAppMessageTemplateHttp)`.
### Managing Message Templates
**Example:** Read a Template
```typescript
// init — bind the operation to the linked WABA
const getTemplate = yield* AWS.SocialMessaging.GetWhatsAppMessageTemplate(account);

// runtime
const { template } = yield* getTemplate({
  metaTemplateId: "1234567890",
});
```

@binding

## GetWhatsAppMessageTemplate.Request

Request for {@link GetWhatsAppMessageTemplate}. The linked WABA `id` is injected by
the binding from the bound {@link LinkedWhatsAppBusinessAccount}.

## ListWhatsAppFlowAssets

Runtime binding for `social-messaging:ListWhatsAppFlowAssets`.

Lists the assets (Flow JSON) of a WhatsApp Flow on the bound account,
with download URLs.

The deploy-time half grants `social-messaging:ListWhatsAppFlowAssets` on the
bound WABA's ARN and the runtime half injects the linked account id
into every request.
Provide the implementation with
`Effect.provide(AWS.SocialMessaging.ListWhatsAppFlowAssetsHttp)`.
### Managing WhatsApp Flows
**Example:** List a Flow's Assets
```typescript
// init — bind the operation to the linked WABA
const listFlowAssets = yield* AWS.SocialMessaging.ListWhatsAppFlowAssets(account);

// runtime
const { flowAssets } = yield* listFlowAssets({
  flowId: "1234567890",
});
```

@binding

## ListWhatsAppFlowAssets.Request

Request for {@link ListWhatsAppFlowAssets}. The linked WABA `id` is injected by
the binding from the bound {@link LinkedWhatsAppBusinessAccount}.

## ListWhatsAppFlows

Runtime binding for `social-messaging:ListWhatsAppFlows`.

Lists the WhatsApp Flows of the bound account with their status and
validation errors.

The deploy-time half grants `social-messaging:ListWhatsAppFlows` on the
bound WABA's ARN and the runtime half injects the linked account id
into every request.
Provide the implementation with
`Effect.provide(AWS.SocialMessaging.ListWhatsAppFlowsHttp)`.
### Managing WhatsApp Flows
**Example:** List Flows
```typescript
// init — bind the operation to the linked WABA
const listFlows = yield* AWS.SocialMessaging.ListWhatsAppFlows(account);

// runtime
const { flows } = yield* listFlows({ maxResults: 25 });
```

@binding

## ListWhatsAppFlows.Request

Request for {@link ListWhatsAppFlows}. The linked WABA `id` is injected by
the binding from the bound {@link LinkedWhatsAppBusinessAccount}.

## ListWhatsAppMessageTemplates

Runtime binding for `social-messaging:ListWhatsAppMessageTemplates`.

Lists the WhatsApp message templates of the bound account, with their
Meta review status and quality score.

The deploy-time half grants `social-messaging:ListWhatsAppMessageTemplates` on the
bound WABA's ARN and the runtime half injects the linked account id
into every request.
Provide the implementation with
`Effect.provide(AWS.SocialMessaging.ListWhatsAppMessageTemplatesHttp)`.
### Managing Message Templates
**Example:** List Templates
```typescript
// init — bind the operation to the linked WABA
const listTemplates = yield* AWS.SocialMessaging.ListWhatsAppMessageTemplates(account);

// runtime
const { templates } = yield* listTemplates({ maxResults: 25 });
```

@binding

## ListWhatsAppMessageTemplates.Request

Request for {@link ListWhatsAppMessageTemplates}. The linked WABA `id` is injected by
the binding from the bound {@link LinkedWhatsAppBusinessAccount}.

## ListWhatsAppTemplateLibrary

Runtime binding for `social-messaging:ListWhatsAppTemplateLibrary`.

Lists the pre-approved templates available in Meta's template library,
optionally filtered by category, topic, or industry.

The deploy-time half grants `social-messaging:ListWhatsAppTemplateLibrary` on the
bound WABA's ARN and the runtime half injects the linked account id
into every request.
Provide the implementation with
`Effect.provide(AWS.SocialMessaging.ListWhatsAppTemplateLibraryHttp)`.
### Managing Message Templates
**Example:** Browse Meta's Template Library
```typescript
// init — bind the operation to the linked WABA
const browseLibrary = yield* AWS.SocialMessaging.ListWhatsAppTemplateLibrary(account);

// runtime
const { metaLibraryTemplates } = yield* browseLibrary({
  filters: { category: "UTILITY" },
});
```

@binding

## ListWhatsAppTemplateLibrary.Request

Request for {@link ListWhatsAppTemplateLibrary}. The linked WABA `id` is injected by
the binding from the bound {@link LinkedWhatsAppBusinessAccount}.

## PostWhatsAppMessageMedia

Runtime binding for `social-messaging:PostWhatsAppMessageMedia`.

Uploads a media file to WhatsApp (from an S3 object or presigned URL) so
it can be referenced by `mediaId` in outbound messages sent from the
given phone number.

The caller addresses one of the bound account's phone numbers per
request; phone-number ARNs are provisioned by Meta under the WABA, so
the deploy-time half grants `social-messaging:PostWhatsAppMessageMedia` on `*`.
Provide the implementation with
`Effect.provide(AWS.SocialMessaging.PostWhatsAppMessageMediaHttp)`.
### Managing Message Media
**Example:** Upload Media from S3
```typescript
// init — bind the operation to the linked WABA
const postMedia = yield* AWS.SocialMessaging.PostWhatsAppMessageMedia(account);

// runtime
const { mediaId } = yield* postMedia({
  originationPhoneNumberId: "phone-number-id-0123456789abcdef",
  sourceS3File: { bucketName: "my-assets", key: "welcome.png" },
});
```

@binding

## PublishWhatsAppFlow

Runtime binding for `social-messaging:PublishWhatsAppFlow`.

Publishes a DRAFT WhatsApp Flow on the bound account so it can be sent to
users. Published flows can no longer be edited, only deprecated.

The deploy-time half grants `social-messaging:PublishWhatsAppFlow` on the
bound WABA's ARN and the runtime half injects the linked account id
into every request.
Provide the implementation with
`Effect.provide(AWS.SocialMessaging.PublishWhatsAppFlowHttp)`.
### Managing WhatsApp Flows
**Example:** Publish a Flow
```typescript
// init — bind the operation to the linked WABA
const publishFlow = yield* AWS.SocialMessaging.PublishWhatsAppFlow(account);

// runtime
yield* publishFlow({ flowId: "1234567890" });
```

@binding

## PublishWhatsAppFlow.Request

Request for {@link PublishWhatsAppFlow}. The linked WABA `id` is injected by
the binding from the bound {@link LinkedWhatsAppBusinessAccount}.

## SendWhatsAppMessage

Runtime binding for `social-messaging:SendWhatsAppMessage`.

Sends a WhatsApp message (text, template, media, or interactive) from one
of the linked account's phone numbers. The `message` blob is the raw Meta
Cloud API message payload and is sensitive — pass it as a `Uint8Array` or
`Redacted<Uint8Array>`.

The caller addresses one of the bound account's phone numbers per
request; phone-number ARNs are provisioned by Meta under the WABA, so
the deploy-time half grants `social-messaging:SendWhatsAppMessage` on `*`.
Provide the implementation with
`Effect.provide(AWS.SocialMessaging.SendWhatsAppMessageHttp)`.
### Sending Messages
**Example:** Send a Text Message
```typescript
// init — bind the operation to the linked WABA
const sendMessage = yield* AWS.SocialMessaging.SendWhatsAppMessage(account);

// runtime
const { messageId } = yield* sendMessage({
  originationPhoneNumberId: "phone-number-id-0123456789abcdef",
  metaApiVersion: "v20.0",
  message: new TextEncoder().encode(
    JSON.stringify({
      messaging_product: "whatsapp",
      to: "+12065550100",
      type: "text",
      text: { body: "Hello from Alchemy" },
    }),
  ),
});
```

@binding

## UpdateWhatsAppFlow

Runtime binding for `social-messaging:UpdateWhatsAppFlow`.

Updates a WhatsApp Flow's name and categories on the bound account.

The deploy-time half grants `social-messaging:UpdateWhatsAppFlow` on the
bound WABA's ARN and the runtime half injects the linked account id
into every request.
Provide the implementation with
`Effect.provide(AWS.SocialMessaging.UpdateWhatsAppFlowHttp)`.
### Managing WhatsApp Flows
**Example:** Rename a Flow
```typescript
// init — bind the operation to the linked WABA
const updateFlow = yield* AWS.SocialMessaging.UpdateWhatsAppFlow(account);

// runtime
yield* updateFlow({
  flowId: "1234567890",
  flowName: "appointment-booking-v2",
});
```

@binding

## UpdateWhatsAppFlow.Request

Request for {@link UpdateWhatsAppFlow}. The linked WABA `id` is injected by
the binding from the bound {@link LinkedWhatsAppBusinessAccount}.

## UpdateWhatsAppFlowAssets

Runtime binding for `social-messaging:UpdateWhatsAppFlowAssets`.

Replaces a WhatsApp Flow's Flow JSON asset on the bound account and
returns any validation errors Meta reports.

The deploy-time half grants `social-messaging:UpdateWhatsAppFlowAssets` on the
bound WABA's ARN and the runtime half injects the linked account id
into every request.
Provide the implementation with
`Effect.provide(AWS.SocialMessaging.UpdateWhatsAppFlowAssetsHttp)`.
### Managing WhatsApp Flows
**Example:** Upload Flow JSON
```typescript
// init — bind the operation to the linked WABA
const updateFlowAssets = yield* AWS.SocialMessaging.UpdateWhatsAppFlowAssets(account);

// runtime
const { validationErrors } = yield* updateFlowAssets({
  flowId: "1234567890",
  flowJson: new TextEncoder().encode(JSON.stringify(flowDefinition)),
});
```

@binding

## UpdateWhatsAppFlowAssets.Request

Request for {@link UpdateWhatsAppFlowAssets}. The linked WABA `id` is injected by
the binding from the bound {@link LinkedWhatsAppBusinessAccount}.

## UpdateWhatsAppMessageTemplate

Runtime binding for `social-messaging:UpdateWhatsAppMessageTemplate`.

Updates an existing WhatsApp message template on the bound account — its
category or component JSON. Edits re-enter Meta review.

The deploy-time half grants `social-messaging:UpdateWhatsAppMessageTemplate` on the
bound WABA's ARN and the runtime half injects the linked account id
into every request.
Provide the implementation with
`Effect.provide(AWS.SocialMessaging.UpdateWhatsAppMessageTemplateHttp)`.
### Managing Message Templates
**Example:** Update a Template
```typescript
// init — bind the operation to the linked WABA
const updateTemplate = yield* AWS.SocialMessaging.UpdateWhatsAppMessageTemplate(account);

// runtime
yield* updateTemplate({
  metaTemplateId: "1234567890",
  templateComponents: new TextEncoder().encode(
    JSON.stringify([{ type: "BODY", text: "Order {{1}} delivered." }]),
  ),
});
```

@binding

## UpdateWhatsAppMessageTemplate.Request

Request for {@link UpdateWhatsAppMessageTemplate}. The linked WABA `id` is injected by
the binding from the bound {@link LinkedWhatsAppBusinessAccount}.
