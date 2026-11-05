import * as mediatailor from "@distilled.cloud/aws/mediatailor";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeMediaTailorHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `mediatailor:DeleteProgram` — remove a scheduled
 * program from a channel-assembly channel.
 *
 * Channel/program names are runtime parameters, so the binding is
 * account-level and grants `mediatailor:DeleteProgram` on `*`. Provide the
 * implementation with `Effect.provide(AWS.MediaTailor.DeleteProgramHttp)`.
 *
 * ### Channel Assembly
 * **Example:** Remove a program from the schedule
 * ```typescript
 * const deleteProgram = yield* AWS.MediaTailor.DeleteProgram();
 *
 * yield* deleteProgram({
 *   ChannelName: "my-channel",
 *   ProgramName: `episode-${id}`,
 * });
 * ```
 *
 * @binding
 */
export interface DeleteProgram extends Binding.Service<
  DeleteProgram,
  "AWS.MediaTailor.DeleteProgram",
  () => Effect.Effect<
    (
      request: mediatailor.DeleteProgramRequest,
    ) => Effect.Effect<mediatailor.DeleteProgramResponse, mediatailor.DeleteProgramError>
  >
> {}
export const DeleteProgram = Binding.Service<DeleteProgram>("AWS.MediaTailor.DeleteProgram");

export const DeleteProgramHttp = Layer.effect(
  DeleteProgram,
  makeMediaTailorHttpBinding({
    capability: "DeleteProgram",
    iamActions: ["mediatailor:DeleteProgram"],
    operation: mediatailor.deleteProgram,
  }),
);
