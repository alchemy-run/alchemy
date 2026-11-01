import * as intake from "@distilled.cloud/stackit/intake";
import * as Layer from "effect/Layer";
import { makeUserHttpBinding } from "./BindingHttp.ts";
import { GetUser } from "./GetUser.ts";

/**
 * HTTP implementation of {@link GetUser}.
 *
 * @layer
 * @provides Stackit.Intake.GetUser
 */
export const GetUserHttp = Layer.effect(
  GetUser,
  makeUserHttpBinding({
    tag: "Stackit.Intake.GetUser",
    permission: "intake.intake.get",
    operation: intake.getIntakeUser,
  }),
);
