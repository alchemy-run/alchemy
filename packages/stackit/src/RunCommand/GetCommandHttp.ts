import * as runCommand from "@distilled.cloud/stackit/run_command";
import * as Layer from "effect/Layer";
import { makeServerCommandHttpBinding } from "./BindingHttp.ts";
import { GetCommand } from "./GetCommand.ts";

/**
 * HTTP implementation of {@link GetCommand}.
 *
 * @layer
 * @provides Stackit.RunCommand.GetCommand
 */
export const GetCommandHttp = Layer.effect(
  GetCommand,
  makeServerCommandHttpBinding({
    tag: "Stackit.RunCommand.GetCommand",
    permission: "run-command.command.get",
    operation: runCommand.getCommand,
  }),
);
