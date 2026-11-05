import * as textract from "@distilled.cloud/aws/textract";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Adapter } from "./Adapter.ts";
import { makeTextractAdapterHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `textract:GetAdapter` — read the configuration
 * (name, feature types, auto-update, tags) of the bound adapter at
 * runtime. The grant is scoped to the adapter's ARN and the `AdapterId`
 * is injected automatically.
 *
 * ### Managing Adapters
 * **Example:** Read the Bound Adapter
 * ```typescript
 * // init
 * const getAdapter = yield* AWS.Textract.GetAdapter(adapter);
 *
 * // runtime
 * const result = yield* getAdapter();
 * console.log(result.AdapterName, result.FeatureTypes);
 * ```
 *
 * @binding
 */
export interface GetAdapter extends Binding.Service<
  GetAdapter,
  "AWS.Textract.GetAdapter",
  <A extends Adapter>(
    adapter: A,
  ) => Effect.Effect<() => Effect.Effect<textract.GetAdapterResponse, textract.GetAdapterError>>
> {}
export const GetAdapter = Binding.Service<GetAdapter>("AWS.Textract.GetAdapter");

export const GetAdapterHttp = Layer.effect(
  GetAdapter,
  makeTextractAdapterHttpBinding({
    capability: "GetAdapter",
    iamActions: ["textract:GetAdapter"],
    operation: textract.getAdapter,
  }),
);
