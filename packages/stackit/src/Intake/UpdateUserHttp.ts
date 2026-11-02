import * as intake from "@distilled.cloud/stackit/intake";
import * as Layer from "effect/Layer";
import { makeUserHttpBinding } from "./BindingHttp.ts";
import { UpdateUser } from "./UpdateUser.ts";

/**
 * HTTP implementation of {@link UpdateUser}.
 *
 * @layer
 * @provides Stackit.Intake.UpdateUser
 */
export const UpdateUserHttp = Layer.effect(
  UpdateUser,
  makeUserHttpBinding({
    tag: "Stackit.Intake.UpdateUser",
    permission: "intake.intake.update",
    operation: intake.updateIntakeUser,
  }),
);
