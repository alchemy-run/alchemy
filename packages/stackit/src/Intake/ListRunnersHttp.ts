import * as intake from "@distilled.cloud/stackit/intake";
import * as Layer from "effect/Layer";
import { makeIntakeScopeHttpBinding } from "./BindingHttp.ts";
import { ListRunners } from "./ListRunners.ts";

/**
 * HTTP implementation of {@link ListRunners}.
 *
 * @layer
 * @provides Stackit.Intake.ListRunners
 */
export const ListRunnersHttp = Layer.effect(
  ListRunners,
  makeIntakeScopeHttpBinding({
    tag: "Stackit.Intake.ListRunners",
    permission: "intake.intake.list",
    operation: intake.listIntakeRunners,
  }),
);
