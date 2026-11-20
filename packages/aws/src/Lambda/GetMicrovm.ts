import * as microvms from "@distilled.cloud/aws/lambda-microvms";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import { makeImageBinding } from "./MicrovmBinding.ts";
import type { MicrovmImage } from "./MicrovmImage.ts";

export interface GetMicrovmRequest extends microvms.GetMicrovmRequest {}

/**
 * Runtime binding for `GetMicrovm`.
 *
 * Bind it to a {@link MicrovmImage} to get a callable that reads the state,
 * endpoint, and configuration of a running MicroVM by `microvmIdentifier`.
 * ### Inspecting MicroVMs
 * **Example:** Get a MicroVM
 * ```typescript
 * const getMicrovm = yield* AWS.Lambda.GetMicrovm(Sandbox);
 * const vm = yield* getMicrovm({ microvmIdentifier: id });
 * ```
 *
 * @binding
 */
export interface GetMicrovm extends Binding.Service<
  GetMicrovm,
  "AWS.Lambda.GetMicrovm",
  (
    image: MicrovmImage,
  ) => Effect.Effect<
    (
      request: GetMicrovmRequest,
    ) => Effect.Effect<microvms.GetMicrovmResponse, microvms.GetMicrovmError>
  >
> {}
export const GetMicrovm = Binding.Service<GetMicrovm>("AWS.Lambda.GetMicrovm");

export const GetMicrovmHttp = makeImageBinding({
  binding: GetMicrovm,
  name: "GetMicrovm",
  actions: ["lambda:GetMicrovm"],
  operation: microvms.getMicrovm,
  // MicroVM instance ARNs are minted at runtime; scope to the image's
  // `microvm:*` glob (this account/region) rather than `["*"]`.
  scope: "microvm",
});
