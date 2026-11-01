import * as runCommand from "@distilled.cloud/stackit/run_command";
import * as Layer from "effect/Layer";
import { makeGlobalCommandHttpBinding } from "./BindingHttp.ts";
import { ListCommandTemplates } from "./ListCommandTemplates.ts";

/**
 * HTTP implementation of {@link ListCommandTemplates}.
 *
 * @layer
 * @provides Stackit.RunCommand.ListCommandTemplates
 */
export const ListCommandTemplatesHttp = Layer.effect(
  ListCommandTemplates,
  makeGlobalCommandHttpBinding({
    tag: "Stackit.RunCommand.ListCommandTemplates",
    operation: runCommand.listCommandTemplates,
  }),
);
