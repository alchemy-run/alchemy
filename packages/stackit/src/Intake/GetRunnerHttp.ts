import * as intake from "@distilled.cloud/stackit/intake";
import * as Layer from "effect/Layer";
import { makeRunnerHttpBinding } from "./BindingHttp.ts";
import { GetRunner } from "./GetRunner.ts";

/**
 * HTTP implementation of {@link GetRunner}.
 *
 * @layer
 * @provides Stackit.Intake.GetRunner
 */
export const GetRunnerHttp = Layer.effect(
  GetRunner,
  makeRunnerHttpBinding({
    tag: "Stackit.Intake.GetRunner",
    permission: "intake.intake.get",
    operation: intake.getIntakeRunner,
  }),
);
