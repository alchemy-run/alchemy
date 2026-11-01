import * as intake from "@distilled.cloud/stackit/intake";
import * as Layer from "effect/Layer";
import { makeIntakeHttpBinding } from "./BindingHttp.ts";
import { GetIntake } from "./GetIntake.ts";

/**
 * HTTP implementation of {@link GetIntake}.
 *
 * @layer
 * @provides Stackit.Intake.GetIntake
 */
export const GetIntakeHttp = Layer.effect(
  GetIntake,
  makeIntakeHttpBinding({
    tag: "Stackit.Intake.GetIntake",
    permission: "intake.intake.get",
    operation: intake.getIntake,
  }),
);
