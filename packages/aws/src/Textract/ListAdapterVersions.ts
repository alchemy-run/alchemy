import * as textract from "@distilled.cloud/aws/textract";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Adapter } from "./Adapter.ts";
import { makeTextractAdapterHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `textract:ListAdapterVersions` — list the versions
 * of the bound adapter and their training status.
 *
 * ### Managing Adapters
 * **Example:** List Adapter Versions
 * ```typescript
 * // init
 * const listAdapterVersions = yield* AWS.Textract.ListAdapterVersions(adapter);
 *
 * // runtime
 * const result = yield* listAdapterVersions();
 * const versions = result.AdapterVersions;
 * ```
 *
 * @binding
 */
export interface ListAdapterVersions extends Binding.Service<
  ListAdapterVersions,
  "AWS.Textract.ListAdapterVersions",
  <A extends Adapter>(
    adapter: A,
  ) => Effect.Effect<
    (
      request?: Omit<textract.ListAdapterVersionsRequest, "AdapterId">,
    ) => Effect.Effect<textract.ListAdapterVersionsResponse, textract.ListAdapterVersionsError>
  >
> {}
export const ListAdapterVersions = Binding.Service<ListAdapterVersions>(
  "AWS.Textract.ListAdapterVersions",
);

export const ListAdapterVersionsHttp = Layer.effect(
  ListAdapterVersions,
  makeTextractAdapterHttpBinding({
    capability: "ListAdapterVersions",
    iamActions: ["textract:ListAdapterVersions"],
    operation: textract.listAdapterVersions,
  }),
);
