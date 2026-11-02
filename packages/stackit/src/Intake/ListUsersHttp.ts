import * as intake from "@distilled.cloud/stackit/intake";
import * as Layer from "effect/Layer";
import { makeIntakeHttpBinding } from "./BindingHttp.ts";
import { ListUsers } from "./ListUsers.ts";

/**
 * HTTP implementation of {@link ListUsers}.
 *
 * @layer
 * @provides Stackit.Intake.ListUsers
 */
export const ListUsersHttp = Layer.effect(
  ListUsers,
  makeIntakeHttpBinding({
    tag: "Stackit.Intake.ListUsers",
    permission: "intake.intake.list",
    operation: intake.listIntakeUsers,
  }),
);
