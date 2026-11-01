import * as runCommand from "@distilled.cloud/stackit/run_command";
import * as Layer from "effect/Layer";
import { makeServerCommandHttpBinding } from "./BindingHttp.ts";
import { ListCommands } from "./ListCommands.ts";

/**
 * HTTP implementation of {@link ListCommands}.
 *
 * @layer
 * @provides Stackit.RunCommand.ListCommands
 */
export const ListCommandsHttp = Layer.effect(
  ListCommands,
  makeServerCommandHttpBinding({
    tag: "Stackit.RunCommand.ListCommands",
    permission: "run-command.command.list",
    operation: runCommand.listCommands,
  }),
);
