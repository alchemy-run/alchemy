import type * as runCommand from "@distilled.cloud/stackit/run_command";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Server } from "../IaaS/Server.ts";

export interface GetCommandRequest extends Omit<
  runCommand.GetCommandRequest,
  "projectId" | "region" | "serverId"
> {}

/**
 * Runtime binding for Run Command `getCommand`: reads one command's status (`pending`,
 * `running`, `completed`, `failed`), exit code, script and output.
 *
 * `output` and `script` come back `Redacted`, because a command's script can hold
 * whatever it was given and its output whatever it printed. Unwrap them only where
 * that is safe to show.
 *
 * Bind this operation to a {@link Server} in a Function/Worker init phase and
 * provide {@link GetCommandHttp}. It works on any host. A foreign host signs with a
 * service account key Alchemy creates for it.
 *
 * Access: a custom role holding only `run-command.command.get` on the project holding
 * the
 * server, so it reaches every server in that project: STACKIT binds roles on
 * projects, folders and organizations, not on a single server. The deployer needs
 * `iam.role.add` on that scope to define the role.
 *
 * ### Reading a Command
 * **Example:** Read a command's status and exit code
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import { HttpServerRequest } from "effect/http/HttpServerRequest";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Web = Stackit.IaaS.Server("Web", {
 *   machineType: "g1.1",
 *   imageId: "00000000-0000-0000-0000-000000000000",
 *   networking: { networkId: "11111111-1111-1111-1111-111111111111" },
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const getCommand = yield* Stackit.RunCommand.GetCommand(yield* Web);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const request = yield* HttpServerRequest;
 *         const url = new URL(request.url, "http://worker");
 *         const command = yield* getCommand({
 *           commandId: url.searchParams.get("id") ?? "",
 *         });
 *         return yield* HttpServerResponse.json({
 *           status: command.status,
 *           exitCode: command.exitCode,
 *         });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.RunCommand.GetCommandHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Run Command
 * @category RunCommand
 */
export interface GetCommand extends Binding.Service<
  GetCommand,
  "Stackit.RunCommand.GetCommand",
  (
    server: Server,
  ) => Effect.Effect<
    (
      request: GetCommandRequest,
    ) => Effect.Effect<runCommand.CommandDetails, runCommand.GetCommandError, RuntimeContext>
  >
> {}

export const GetCommand = Binding.Service<GetCommand>("Stackit.RunCommand.GetCommand");
