import * as qbusiness from "@distilled.cloud/aws/qbusiness";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Application } from "./Application.ts";
import { makeQBusinessApplicationHttpBinding } from "./BindingHttp.ts";

/**
 * `ListAttachments` request with `applicationId` injected from the bound application.
 */
export interface ListAttachmentsRequest extends Omit<
  qbusiness.ListAttachmentsRequest,
  "applicationId"
> {}

/**
 * Runtime binding for the `ListAttachments` operation (IAM action
 * `qbusiness:ListAttachments`), scoped to one {@link Application}.
 *
 * Lists the files attached to chat conversations.
 * Provide the implementation with
 * `Effect.provide(AWS.QBusiness.ListAttachmentsHttp)`.
 *
 * ### Conversations
 * **Example:** List Attachments
 * ```typescript
 * const listAttachments = yield* AWS.QBusiness.ListAttachments(app);
 *
 * const { attachments } = yield* listAttachments({ conversationId });
 * ```
 *
 * @binding
 */
export interface ListAttachments extends Binding.Service<
  ListAttachments,
  "AWS.QBusiness.ListAttachments",
  (
    application: Application,
  ) => Effect.Effect<
    (
      request?: ListAttachmentsRequest,
    ) => Effect.Effect<qbusiness.ListAttachmentsResponse, qbusiness.ListAttachmentsError>
  >
> {}
export const ListAttachments = Binding.Service<ListAttachments>("AWS.QBusiness.ListAttachments");

export const ListAttachmentsHttp = Layer.effect(
  ListAttachments,
  makeQBusinessApplicationHttpBinding({
    tag: "AWS.QBusiness.ListAttachments",
    operation: qbusiness.listAttachments,
    actions: ["qbusiness:ListAttachments"],
  }),
);
