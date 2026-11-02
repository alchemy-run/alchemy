import type * as runCommand from "@distilled.cloud/stackit/run_command";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Server } from "../IaaS/Server.ts";

export interface GetCommandTemplateRequest extends Omit<
  runCommand.GetCommandTemplateRequest,
  "projectId" | "region" | "serverId"
> {}

/**
 * Runtime binding for Run Command `getCommandTemplate`: reads a command template's
 * description and parameter schema, for a server.
 *
 * Bind this operation to a {@link Server} in a Function/Worker init phase and
 * provide {@link GetCommandTemplateHttp}. It works on any host. A foreign host signs
 * with a
 * service account key Alchemy creates for it.
 *
 * Access: a custom role holding only `run-command.command-template.get` on the project
 * holding the server, so it reaches every server in that project: STACKIT binds roles
 * on projects, folders and organizations, not on a single server. The deployer needs
 * `iam.role.add` on that scope to define the role.
 *
 * ### Reading a Template
 * **Example:** Read the template behind a command
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
 *     const getTemplate = yield* Stackit.RunCommand.GetCommandTemplate(yield* Web);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const template = yield* getTemplate({ commandTemplateName: "RunShellScript" });
 *         return yield* HttpServerResponse.json({ title: template.title });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.RunCommand.GetCommandTemplateHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Run Command
 * @category RunCommand
 */
export interface GetCommandTemplate extends Binding.Service<
  GetCommandTemplate,
  "Stackit.RunCommand.GetCommandTemplate",
  (
    server: Server,
  ) => Effect.Effect<
    (
      request: GetCommandTemplateRequest,
    ) => Effect.Effect<
      runCommand.CommandTemplateSchema,
      runCommand.GetCommandTemplateError,
      RuntimeContext
    >
  >
> {}

export const GetCommandTemplate = Binding.Service<GetCommandTemplate>(
  "Stackit.RunCommand.GetCommandTemplate",
);
