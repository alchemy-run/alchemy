import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ApiAccess } from "./ArchilBindings.ts";
import { makeSandboxOps, type SandboxOps } from "./Clients.ts";
import type { Sandbox } from "./Sandbox.ts";

/**
 * The handle on a deploy-time sandbox: a {@link SandboxHandle} whose id and
 * name resolve at run time.
 */
export interface ConnectSandboxClient extends SandboxOps {
  readonly sandboxId: Effect.Effect<string, never, RuntimeContext>;
  readonly name: Effect.Effect<string, never, RuntimeContext>;
}

/**
 * Act on a sandbox declared at deploy time from a Worker, Lambda, or any
 * other host: run commands, start background processes and terminals,
 * move files, pause and resume, fork it into a new sandbox, open ports,
 * and change its network policy. A program sandbox (`Archil.Sandbox` with
 * `main`) is a sandbox too.
 *
 * ### Driving a Dev Box
 * **Example:** Build on the dev box, fork a preview per pull request
 * ```typescript
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const devbox = yield* Archil.ConnectSandbox(DevBox);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* devbox.exec("git pull && pnpm build", { cwd: "/workspace" });
 *         yield* devbox.files.write("/workspace/.env", "PREVIEW=1\n");
 *         const preview = yield* devbox.fork({ name: "pr-42" });
 *         const port = yield* preview.exposePort(3000);
 *         return HttpServerResponse.text(`https://${port.hostname}`);
 *       }),
 *     };
 *   }).pipe(Effect.provide(Archil.ConnectSandboxHttp)),
 * ) {}
 * ```
 *
 * ### Proxying to a Port
 * **Example:** A Worker in front of the dev box's server
 * ```typescript
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const devbox = yield* Archil.ConnectSandbox(DevBox);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const port = yield* devbox.getTcpPort(3000);
 *         return yield* port.fetch(yield* HttpServerRequest);
 *       }),
 *     };
 *   }).pipe(Effect.provide(Archil.ConnectSandboxHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Sandbox
 */
export interface ConnectSandbox extends Binding.Service<
  ConnectSandbox,
  "Archil.ConnectSandbox",
  (sandbox: Sandbox) => Effect.Effect<ConnectSandboxClient>
> {}

export const ConnectSandbox = Binding.Service<ConnectSandbox>("Archil.ConnectSandbox");

/** {@link ConnectSandbox} over Archil's HTTP API, usable from any host. */
export const ConnectSandboxHttp = Layer.effect(
  ConnectSandbox,
  Effect.gen(function* () {
    const access = yield* ApiAccess;
    return Effect.fn(function* (sandbox: Sandbox) {
      const authorize = yield* access();
      const sandboxId = yield* sandbox.sandboxId;
      const name = yield* sandbox.name;
      return {
        sandboxId,
        name,
        ...makeSandboxOps(sandboxId, authorize),
      } satisfies ConnectSandboxClient;
    });
  }),
);
