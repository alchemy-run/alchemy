import * as sns from "@distilled.cloud/aws/sns";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeSnsEndpointHttpBinding } from "./BindingHttp.ts";
import type { PlatformApplication } from "./PlatformApplication.ts";

export interface DeleteEndpointRequest extends sns.DeleteEndpointInput {}

/**
 * Runtime binding for `sns:DeleteEndpoint`.
 *
 * Bind this operation to a {@link PlatformApplication} to deregister one
 * of its device endpoints (idempotent).
 * Provide the `DeleteEndpointHttp` layer on the Function to implement the binding.
 * ### Mobile Push
 * **Example:** Delete an Endpoint
 * ```typescript
 * const deleteEndpoint = yield* SNS.DeleteEndpoint(app);
 * yield* deleteEndpoint({ EndpointArn: endpointArn });
 * ```
 *
 * @binding
 */
export interface DeleteEndpoint extends Binding.Service<
  DeleteEndpoint,
  "AWS.SNS.DeleteEndpoint",
  (
    application: PlatformApplication,
  ) => Effect.Effect<
    (
      request: DeleteEndpointRequest,
    ) => Effect.Effect<sns.DeleteEndpointResponse, sns.DeleteEndpointError>
  >
> {}

export const DeleteEndpoint = Binding.Service<DeleteEndpoint>("AWS.SNS.DeleteEndpoint");

export const DeleteEndpointHttp = Layer.effect(
  DeleteEndpoint,
  makeSnsEndpointHttpBinding({
    tag: "AWS.SNS.DeleteEndpoint",
    operation: sns.deleteEndpoint,
    actions: ["sns:DeleteEndpoint"],
  }),
);
