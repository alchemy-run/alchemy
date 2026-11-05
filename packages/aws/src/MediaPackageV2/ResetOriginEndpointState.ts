import * as mediapackagev2 from "@distilled.cloud/aws/mediapackagev2";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeMediaPackageV2OriginEndpointHttpBinding } from "./BindingHttp.ts";
import type { OriginEndpoint } from "./OriginEndpoint.ts";

/**
 * Runtime binding for `mediapackagev2:ResetOriginEndpointState`.
 *
 * Resets the packaging state of the bound {@link OriginEndpoint} — clearing
 * its manifests and cached segments so playback restarts clean after the
 * channel's content was reset or replaced. The endpoint's group, channel,
 * and name are injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.MediaPackageV2.ResetOriginEndpointStateHttp)`.
 * ### Resetting Ingest State
 * **Example:** Reset an Endpoint After Resetting Its Channel
 * ```typescript
 * // init — bind the operation to the endpoint
 * const resetEndpoint =
 *   yield* AWS.MediaPackageV2.ResetOriginEndpointState(endpoint);
 *
 * // runtime
 * const { ResetAt } = yield* resetEndpoint();
 * ```
 *
 * @binding
 */
export interface ResetOriginEndpointState extends Binding.Service<
  ResetOriginEndpointState,
  "AWS.MediaPackageV2.ResetOriginEndpointState",
  (
    endpoint: OriginEndpoint,
  ) => Effect.Effect<
    () => Effect.Effect<
      mediapackagev2.ResetOriginEndpointStateResponse,
      mediapackagev2.ResetOriginEndpointStateError
    >
  >
> {}
export const ResetOriginEndpointState = Binding.Service<ResetOriginEndpointState>(
  "AWS.MediaPackageV2.ResetOriginEndpointState",
);

export const ResetOriginEndpointStateHttp = Layer.effect(
  ResetOriginEndpointState,
  makeMediaPackageV2OriginEndpointHttpBinding({
    tag: "AWS.MediaPackageV2.ResetOriginEndpointState",
    operation: mediapackagev2.resetOriginEndpointState,
    actions: ["mediapackagev2:ResetOriginEndpointState"],
  }),
);
