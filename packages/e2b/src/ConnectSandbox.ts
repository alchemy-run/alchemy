import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { Sandbox } from "./Sandbox.ts";
import type { ConnectedSandbox } from "./SandboxClient.ts";

/**
 * Work with one {@link Sandbox} declared in the stack, from a Worker,
 * Function or any other host: run commands, read and write files, open
 * terminals, call its ports, snapshot or fork it. The handle has the same
 * operations as the sandboxes `CreateSandbox` returns; its `sandboxId` and
 * `url(port)` are Effects, read at runtime.
 *
 * A declared sandbox pauses when it is idle. With `autoResume` (the
 * default), E2B resumes it on the next request, to one of its ports or from
 * any call here. With `autoResume: false`, calls inside it (`exec`,
 * `start`, `files`, `pty`) fail with `SandboxNotRunning` until you call
 * `resume()`.
 *
 * The host gets its own E2B API key, minted at deploy and revoked when the
 * host is destroyed. E2B keys are not scoped, so the key reaches the whole
 * team; it is never the deployer's own.
 *
 * ### Running commands in a dev box
 * **Example:** Pull and test on request
 * ```typescript
 * const devBox = yield* E2B.ConnectSandbox(DevBox);
 * return {
 *   fetch: Effect.gen(function* () {
 *     yield* devBox.resume({ timeout: "10 minutes" });
 *     const test = yield* devBox.exec("git pull && npm test", { cwd: "/home/user/repo" });
 *     return yield* HttpServerResponse.json(test);
 *   }),
 * };
 * ```
 *
 * ### Streaming a process
 * **Example:** Stream a build's output
 * ```typescript
 * const build = yield* devBox.start("npm run build", { cwd: "/home/user/repo" });
 * const output = build.output.pipe(Stream.map((chunk) => chunk.data));
 * ```
 *
 * ### Calling a program in the sandbox
 * **Example:** Call port 3000
 * ```typescript
 * const port = yield* api.getTcpPort(3000);
 * const response = yield* port.fetch(HttpClientRequest.get("/health"));
 * ```
 *
 * **Example:** Proxy the Worker's request to port 3000
 * ```typescript
 * const port = yield* api.getTcpPort(3000);
 * return yield* port.fetch(yield* HttpServerRequest);
 * ```
 *
 * ### Pausing it early
 * **Example:** Pause when the work is done
 * ```typescript
 * yield* devBox.pause();
 * ```
 *
 * @binding
 * @product Sandbox
 */
export interface ConnectSandbox extends Binding.Service<
  ConnectSandbox,
  "E2B.ConnectSandbox",
  (sandbox: Sandbox) => Effect.Effect<ConnectedSandbox>
> {}

export const ConnectSandbox = Binding.Service<ConnectSandbox>("E2B.ConnectSandbox");
