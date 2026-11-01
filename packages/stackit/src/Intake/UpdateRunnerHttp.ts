import * as intake from "@distilled.cloud/stackit/intake";
import * as Layer from "effect/Layer";
import { makeRunnerHttpBinding } from "./BindingHttp.ts";
import { UpdateRunner } from "./UpdateRunner.ts";

/**
 * HTTP implementation of {@link UpdateRunner}.
 *
 * @layer
 * @provides Stackit.Intake.UpdateRunner
 */
export const UpdateRunnerHttp = Layer.effect(
  UpdateRunner,
  makeRunnerHttpBinding({
    tag: "Stackit.Intake.UpdateRunner",
    permission: "intake.intake.update",
    operation: intake.updateIntakeRunner,
  }),
);
