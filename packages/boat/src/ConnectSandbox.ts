import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { Sandbox } from "./Sandbox.ts";
import type { ConnectedSandbox } from "./SandboxClient.ts";

/**
 * Work with one {@link Sandbox} declared in the stack, from a Worker,
 * Function or any other host: run commands, read and write files, call its
 * ports, stop, resume or snapshot it. The handle has the same operations
 * as the sandboxes `CreateSandbox` returns, except `fork` and `delete`; its
 * `sandboxId` is an Effect, read at runtime.
 *
 * A declared sandbox stops after its `autoStop`. Calls into it then fail
 * with `SandboxNotRunning` until you `resume()` it.
 *
 * The host gets its own Boat API key, minted at deploy and revoked when the
 * host is destroyed. The key reaches only this sandbox.
 *
 * ### Running commands in a dev box
 * **Example:** Pull and test on request
 * ```typescript
 * const devBox = yield* Boat.ConnectSandbox(DevBox);
 * return {
 *   fetch: Effect.gen(function* () {
 *     yield* devBox.resume({ autoStop: "10 minutes" });
 *     const test = yield* devBox.exec("git pull && npm test", { cwd: "/home/user/repo" });
 *     return yield* HttpServerResponse.json(test);
 *   }),
 * };
 * ```
 *
 * ### Calling a program in the sandbox
 * **Example:** Call port 3000
 * ```typescript
 * const port = yield* devBox.getTcpPort(3000);
 * const response = yield* port.fetch(HttpClientRequest.get("/health"));
 * ```
 *
 * **Example:** Proxy the Worker's request to port 3000
 * ```typescript
 * const port = yield* devBox.getTcpPort(3000);
 * return yield* port.fetch(yield* HttpServerRequest);
 * ```
 *
 * ### Stopping it early
 * **Example:** Stop when the work is done
 * ```typescript
 * yield* devBox.stop();
 * ```
 *
 * @binding
 * @product Sandbox
 */
export interface ConnectSandbox extends Binding.Service<
  ConnectSandbox,
  "Boat.ConnectSandbox",
  (sandbox: Sandbox) => Effect.Effect<ConnectedSandbox>
> {}

export const ConnectSandbox = Binding.Service<ConnectSandbox>("Boat.ConnectSandbox");
