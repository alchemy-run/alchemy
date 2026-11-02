import type * as runCommand from "@distilled.cloud/stackit/run_command";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Server } from "../IaaS/Server.ts";

export interface ListCommandsRequest extends Omit<
  runCommand.ListCommandsRequest,
  "projectId" | "region" | "serverId"
> {}

/**
 * Runtime binding for Run Command `listCommands`: lists the commands a server has run,
 * without their output.
 *
 * Bind this operation to a {@link Server} in a Function/Worker init phase and
 * provide {@link ListCommandsHttp}. It works on any host. A foreign host signs with a
 * service account key Alchemy creates for it.
 *
 * Access: a custom role holding only `run-command.command.list` on the project holding
 * the
 * server, so it reaches every server in that project: STACKIT binds roles on
 * projects, folders and organizations, not on a single server. The deployer needs
 * `iam.role.add` on that scope to define the role.
 *
 * ### Listing Commands
 * **Example:** List the commands a server has run
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
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
 *     const listCommands = yield* Stackit.RunCommand.ListCommands(yield* Web);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { items } = yield* listCommands();
 *         return yield* HttpServerResponse.json(items ?? []);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.RunCommand.ListCommandsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Run Command
 * @category RunCommand
 */
export interface ListCommands extends Binding.Service<
  ListCommands,
  "Stackit.RunCommand.ListCommands",
  (
    server: Server,
  ) => Effect.Effect<
    (
      request?: ListCommandsRequest,
    ) => Effect.Effect<runCommand.GetCommandsResponse, runCommand.ListCommandsError, RuntimeContext>
  >
> {}

export const ListCommands = Binding.Service<ListCommands>("Stackit.RunCommand.ListCommands");
