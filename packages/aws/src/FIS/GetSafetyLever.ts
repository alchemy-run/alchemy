import * as fis from "@distilled.cloud/aws/fis";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeFisAccountHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `fis:GetSafetyLever`.
 *
 * Reads the account's safety lever — the emergency switch that, when
 * `engaged`, stops all running experiments and prevents new ones from
 * starting. The account's lever has the well-known id `default`. Provide the
 * implementation with `Effect.provide(AWS.FIS.GetSafetyLeverHttp)`.
 * ### The Safety Lever
 * **Example:** Check Whether Experiments Are Halted
 * ```typescript
 * // init — account-level binding, no resource argument
 * const getSafetyLever = yield* AWS.FIS.GetSafetyLever();
 *
 * // runtime
 * const { safetyLever } = yield* getSafetyLever({ id: "default" });
 * console.log(safetyLever?.state?.status); // "disengaged"
 * ```
 *
 * @binding
 */
export interface GetSafetyLever extends Binding.Service<
  GetSafetyLever,
  "AWS.FIS.GetSafetyLever",
  () => Effect.Effect<
    (
      request: fis.GetSafetyLeverRequest,
    ) => Effect.Effect<fis.GetSafetyLeverResponse, fis.GetSafetyLeverError>
  >
> {}
export const GetSafetyLever = Binding.Service<GetSafetyLever>("AWS.FIS.GetSafetyLever");

export const GetSafetyLeverHttp = Layer.effect(
  GetSafetyLever,
  makeFisAccountHttpBinding({
    tag: "AWS.FIS.GetSafetyLever",
    operation: fis.getSafetyLever,
    actions: ["fis:GetSafetyLever"],
  }),
);
