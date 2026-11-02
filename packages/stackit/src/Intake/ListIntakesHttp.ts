import * as intake from "@distilled.cloud/stackit/intake";
import * as Layer from "effect/Layer";
import { makeIntakeScopeHttpBinding } from "./BindingHttp.ts";
import { ListIntakes } from "./ListIntakes.ts";

/**
 * HTTP implementation of {@link ListIntakes}.
 *
 * @layer
 * @provides Stackit.Intake.ListIntakes
 */
export const ListIntakesHttp = Layer.effect(
  ListIntakes,
  makeIntakeScopeHttpBinding({
    tag: "Stackit.Intake.ListIntakes",
    permission: "intake.intake.list",
    operation: intake.listIntakes,
  }),
);
