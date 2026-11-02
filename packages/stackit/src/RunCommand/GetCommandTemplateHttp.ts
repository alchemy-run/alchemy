import * as runCommand from "@distilled.cloud/stackit/run_command";
import * as Layer from "effect/Layer";
import { makeServerCommandHttpBinding } from "./BindingHttp.ts";
import { GetCommandTemplate } from "./GetCommandTemplate.ts";

/**
 * HTTP implementation of {@link GetCommandTemplate}.
 *
 * @layer
 * @provides Stackit.RunCommand.GetCommandTemplate
 */
export const GetCommandTemplateHttp = Layer.effect(
  GetCommandTemplate,
  makeServerCommandHttpBinding({
    tag: "Stackit.RunCommand.GetCommandTemplate",
    permission: "run-command.command-template.get",
    operation: runCommand.getCommandTemplate,
  }),
);
