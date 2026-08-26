import type * as speech from "@distilled.cloud/gcp/speech_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { CustomClasse } from "./CustomClasse.ts";

export interface GetCustomClasseRequest extends Omit<
  speech.GetProjectsLocationsCustomClassesRequest,
  "name"
> {}

/**
 * Runtime binding for Speech-to-Text `customClasses.get`.
 *
 * Bind this operation to a {@link CustomClasse} in a Function/Action
 * init phase. Provide {@link GetCustomClasseHttp}.
 *
 * ### Reading a Custom Class
 * **Example:** Read the bound custom class
 * ```typescript
 * const getClass = yield* GCP.Speech.GetCustomClasse(ships);
 * const live = yield* getClass();
 * ```
 *
 * @binding
 * @product GCP
 * @category Speech
 */
export interface GetCustomClasse extends Binding.Service<
  GetCustomClasse,
  "GCP.Speech.GetCustomClasse",
  (
    customClass: CustomClasse,
  ) => Effect.Effect<
    (
      request?: GetCustomClasseRequest,
    ) => Effect.Effect<
      speech.CustomClass,
      speech.GetProjectsLocationsCustomClassesError,
      RuntimeContext
    >
  >
> {}

export const GetCustomClasse = Binding.Service<GetCustomClasse>(
  "GCP.Speech.GetCustomClasse",
);

/** Alias matching the Speech-to-Text API type name. */
export const GetCustomClass = GetCustomClasse;
export type GetCustomClass = GetCustomClasse;
