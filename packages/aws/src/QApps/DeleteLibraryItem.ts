import * as qapps from "@distilled.cloud/aws/qapps";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeQAppsInstanceHttpBinding } from "./BindingHttp.ts";
import type { QApp } from "./QApp.ts";

/**
 * Request for {@link DeleteLibraryItem} — `instanceId` is injected from the bound Q App.
 */
export interface DeleteLibraryItemRequest extends Omit<
  qapps.DeleteLibraryItemInput,
  "instanceId"
> {}

/**
 * Runtime binding for `qapps:DeleteLibraryItem`.
 *
 * Unpublishes a library item, removing the app from the instance's library. Provide the implementation with
 * `Effect.provide(AWS.QApps.DeleteLibraryItemHttp)`.
 * ### Library Items
 * **Example:** Delete a Library Item
 * ```typescript
 * // init — bind the operation to the Q App
 * const deleteLibraryItem = yield* AWS.QApps.DeleteLibraryItem(app);
 *
 * // runtime
 * yield* deleteLibraryItem({ libraryItemId });
 * ```
 *
 * @binding
 */
export interface DeleteLibraryItem extends Binding.Service<
  DeleteLibraryItem,
  "AWS.QApps.DeleteLibraryItem",
  (
    app: QApp,
  ) => Effect.Effect<
    (
      request: DeleteLibraryItemRequest,
    ) => Effect.Effect<qapps.DeleteLibraryItemResponse, qapps.DeleteLibraryItemError>
  >
> {}

export const DeleteLibraryItem = Binding.Service<DeleteLibraryItem>("AWS.QApps.DeleteLibraryItem");

export const DeleteLibraryItemHttp = Layer.effect(
  DeleteLibraryItem,
  makeQAppsInstanceHttpBinding({
    capability: "DeleteLibraryItem",
    iamActions: ["qapps:DeleteLibraryItem"],
    operation: qapps.deleteLibraryItem,
  }),
);
