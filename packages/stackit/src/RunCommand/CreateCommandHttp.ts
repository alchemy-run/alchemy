import * as runCommand from "@distilled.cloud/stackit/run_command";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Server } from "../IaaS/Server.ts";
import { RUN_COMMAND_SERVICE_ID } from "../internal/commandHost.ts";
import { Service as EnabledService } from "../ServiceEnablement/Service.ts";
import { makeServerCommandHttpBinding } from "./BindingHttp.ts";
import { CreateCommand } from "./CreateCommand.ts";

/**
 * HTTP implementation of {@link CreateCommand}. Unlike the other Run Command
 * operations, this one needs the service enabled in the server's project.
 *
 * @layer
 * @provides Stackit.RunCommand.CreateCommand
 */
export const CreateCommandHttp = Layer.effect(
  CreateCommand,
  Effect.gen(function* () {
    const bindServer = yield* makeServerCommandHttpBinding({
      tag: "Stackit.RunCommand.CreateCommand",
      permission: "run-command.command.create",
      operation: runCommand.createCommand,
    });
    if (globalThis.__ALCHEMY_RUNTIME__) return bindServer;
    const Enablement = yield* EnabledService;
    return (server: Server) =>
      Enablement(`${server.LogicalId}RunCommandService`, {
        serviceId: RUN_COMMAND_SERVICE_ID,
        projectId: server.projectId,
        region: server.region,
        disableOnDelete: false,
      }).pipe(Effect.andThen(bindServer(server)));
  }),
);
