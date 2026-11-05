import * as mediatailor from "@distilled.cloud/aws/mediatailor";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeMediaTailorHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `mediatailor:CreateProgram` — schedule a VOD or live
 * source as a program on a channel-assembly channel. Dynamic program
 * scheduling is the core runtime workflow of channel assembly: applications
 * insert programs into a linear channel's schedule as content becomes
 * available.
 *
 * Channel/program names are runtime parameters, so the binding is
 * account-level and grants `mediatailor:CreateProgram` on `*`. Provide the
 * implementation with `Effect.provide(AWS.MediaTailor.CreateProgramHttp)`.
 *
 * ### Channel Assembly
 * **Example:** Append a VOD source to a channel
 * ```typescript
 * const createProgram = yield* AWS.MediaTailor.CreateProgram();
 *
 * yield* createProgram({
 *   ChannelName: "my-channel",
 *   ProgramName: `episode-${id}`,
 *   SourceLocationName: "my-origin",
 *   VodSourceName: "episode-1",
 *   ScheduleConfiguration: { Transition: { Type: "RELATIVE", RelativePosition: "AFTER_PROGRAM" } },
 * });
 * ```
 *
 * @binding
 */
export interface CreateProgram extends Binding.Service<
  CreateProgram,
  "AWS.MediaTailor.CreateProgram",
  () => Effect.Effect<
    (
      request: mediatailor.CreateProgramRequest,
    ) => Effect.Effect<mediatailor.CreateProgramResponse, mediatailor.CreateProgramError>
  >
> {}
export const CreateProgram = Binding.Service<CreateProgram>("AWS.MediaTailor.CreateProgram");

export const CreateProgramHttp = Layer.effect(
  CreateProgram,
  makeMediaTailorHttpBinding({
    capability: "CreateProgram",
    iamActions: ["mediatailor:CreateProgram"],
    operation: mediatailor.createProgram,
  }),
);
