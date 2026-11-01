import type * as runCommand from "@distilled.cloud/stackit/run_command";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Server } from "../IaaS/Server.ts";

export interface CreateCommandRequest extends Omit<
  runCommand.CreateCommandRequest,
  "projectId" | "region" | "serverId"
> {}

/**
 * Runtime binding for Run Command `createCommand`: runs a command template on a server
 * through its Server Agent, and returns the id of the queued command.
 *
 * `RunShellScript` takes the script as `parameters.script`, up to the 10,000
 * characters STACKIT documents. The command is queued: read its status and output
 * with {@link GetCommand}. The API keeps a command's script and output in its history
 * for anyone holding `run-command.command.get`, so don't put a secret in a script. For
 * the same reason the SDK types `parameters` as `Redacted`-capable, and returns
 * `script` and `output` that way.
 *
 * The server needs the Server Agent (`agent` on `Stackit.IaaS.Server`), and the
 * project needs the service enabled. This binding enables it at deploy with a
 * `Stackit.ServiceEnablement.Service`, and leaves it enabled on destroy, because other
 * stacks in the project may use it.
 *
 * Bind this operation to a {@link Server} in a Function/Worker init phase and
 * provide {@link CreateCommandHttp}. It works on any host. A foreign host signs with a
 * service account key Alchemy creates for it.
 *
 * Access: a custom role holding only `run-command.command.create` on the project
 * holding the server, so it reaches every server in that project: STACKIT binds roles
 * on projects, folders and organizations, not on a single server. The deployer needs
 * `iam.role.add` on that scope to define the role.
 *
 * ### Running a Script
 * **Example:** Run a shell script on the server
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
 *     const createCommand = yield* Stackit.RunCommand.CreateCommand(yield* Web);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { id } = yield* createCommand({
 *           commandTemplateName: "RunShellScript",
 *           parameters: { script: "uname -a" },
 *         });
 *         return yield* HttpServerResponse.json({ id });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.RunCommand.CreateCommandHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Run Command
 * @category RunCommand
 */
export interface CreateCommand extends Binding.Service<
  CreateCommand,
  "Stackit.RunCommand.CreateCommand",
  (
    server: Server,
  ) => Effect.Effect<
    (
      request: CreateCommandRequest,
    ) => Effect.Effect<runCommand.NewCommandResponse, runCommand.CreateCommandError, RuntimeContext>
  >
> {}

export const CreateCommand = Binding.Service<CreateCommand>("Stackit.RunCommand.CreateCommand");
