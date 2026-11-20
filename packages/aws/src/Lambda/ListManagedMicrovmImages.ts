import * as microvms from "@distilled.cloud/aws/lambda-microvms";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import { makeAccountBinding } from "./MicrovmBinding.ts";

export interface ListManagedMicrovmImagesRequest extends microvms.ListManagedMicrovmImagesInput {}

/**
 * Runtime binding for `ListManagedMicrovmImages` (account-scoped).
 *
 * Lists the AWS-managed base MicroVM images available for use as
 * `baseImage`. Bind with no resource: `yield* AWS.Lambda.ListManagedMicrovmImages()`.
 * ### Managed Base Images
 *
 * @binding
 */
export interface ListManagedMicrovmImages extends Binding.Service<
  ListManagedMicrovmImages,
  "AWS.Lambda.ListManagedMicrovmImages",
  () => Effect.Effect<
    (
      request: ListManagedMicrovmImagesRequest,
    ) => Effect.Effect<
      microvms.ListManagedMicrovmImagesOutput,
      microvms.ListManagedMicrovmImagesError
    >
  >
> {}
export const ListManagedMicrovmImages = Binding.Service<ListManagedMicrovmImages>(
  "AWS.Lambda.ListManagedMicrovmImages",
);

export const ListManagedMicrovmImagesHttp = makeAccountBinding({
  binding: ListManagedMicrovmImages,
  name: "ListManagedMicrovmImages",
  actions: ["lambda:ListManagedMicrovmImages"],
  operation: microvms.listManagedMicrovmImages,
});
