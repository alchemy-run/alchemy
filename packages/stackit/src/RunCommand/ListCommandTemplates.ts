import type * as runCommand from "@distilled.cloud/stackit/run_command";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";

/**
 * Runtime binding for Run Command `listCommandTemplates`: the command templates
 * STACKIT offers, optionally for one `osType` (`linux` or `windows`).
 *
 * The operation takes no project, and STACKIT's spec disables authorization on it,
 * so this binding has no bound resource and grants no role. Provide
 * {@link ListCommandTemplatesHttp}. A foreign host signs with a service account key
 * Alchemy creates for it.
 *
 * ### Listing Templates
 * **Example:** List the Linux command templates
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const listTemplates = yield* Stackit.RunCommand.ListCommandTemplates();
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { items } = yield* listTemplates({ osType: "linux" });
 *         return yield* HttpServerResponse.json((items ?? []).map((item) => item.name));
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.RunCommand.ListCommandTemplatesHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Run Command
 * @category RunCommand
 */
export interface ListCommandTemplates extends Binding.Service<
  ListCommandTemplates,
  "Stackit.RunCommand.ListCommandTemplates",
  () => Effect.Effect<
    (
      request?: runCommand.ListCommandTemplatesRequest,
    ) => Effect.Effect<
      runCommand.CommandTemplateResponse,
      runCommand.ListCommandTemplatesError,
      RuntimeContext
    >
  >
> {}

export const ListCommandTemplates = Binding.Service<ListCommandTemplates>(
  "Stackit.RunCommand.ListCommandTemplates",
);
