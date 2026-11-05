import * as qbusiness from "@distilled.cloud/aws/qbusiness";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Application } from "./Application.ts";
import { makeQBusinessApplicationHttpBinding } from "./BindingHttp.ts";

/**
 * `DeleteAttachment` request with `applicationId` injected from the bound application.
 */
export interface DeleteAttachmentRequest extends Omit<
  qbusiness.DeleteAttachmentRequest,
  "applicationId"
> {}

/**
 * Runtime binding for the `DeleteAttachment` operation (IAM action
 * `qbusiness:DeleteAttachment`), scoped to one {@link Application}.
 *
 * Deletes an attachment associated with a chat conversation.
 * Provide the implementation with
 * `Effect.provide(AWS.QBusiness.DeleteAttachmentHttp)`.
 *
 * ### Conversations
 * **Example:** Delete an Attachment
 * ```typescript
 * const deleteAttachment = yield* AWS.QBusiness.DeleteAttachment(app);
 *
 * yield* deleteAttachment({ conversationId, attachmentId });
 * ```
 *
 * @binding
 */
export interface DeleteAttachment extends Binding.Service<
  DeleteAttachment,
  "AWS.QBusiness.DeleteAttachment",
  (
    application: Application,
  ) => Effect.Effect<
    (
      request: DeleteAttachmentRequest,
    ) => Effect.Effect<qbusiness.DeleteAttachmentResponse, qbusiness.DeleteAttachmentError>
  >
> {}
export const DeleteAttachment = Binding.Service<DeleteAttachment>("AWS.QBusiness.DeleteAttachment");

export const DeleteAttachmentHttp = Layer.effect(
  DeleteAttachment,
  makeQBusinessApplicationHttpBinding({
    tag: "AWS.QBusiness.DeleteAttachment",
    operation: qbusiness.deleteAttachment,
    actions: ["qbusiness:DeleteAttachment"],
  }),
);
