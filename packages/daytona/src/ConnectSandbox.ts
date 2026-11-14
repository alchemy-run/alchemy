import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { Sandbox } from "./Sandbox.ts";
import type { ConnectedSandbox } from "./SandboxClient.ts";

/**
 * Work with one {@link Sandbox} declared at deploy, from any host: run
 * commands, read and write files, use git, open previews, fork it or
 * snapshot it. The handle has the same methods as the
 * {@link DaytonaSandbox} that {@link CreateSandbox} returns; its
 * `sandboxId`, `name` and `toolboxProxyUrl` are Effects, resolved at
 * runtime.
 *
 * The host gets its own Daytona API key with `write:sandboxes` and
 * `delete:sandboxes`; Daytona checks permissions per kind of object, so
 * the key can reach other sandboxes in the organization too.
 *
 * ### Running Commands in a Dev Box
 * **Example:** Pull and test on request
 * ```typescript
 * const devBox = yield* Daytona.ConnectSandbox(DevBox);
 * return {
 *   fetch: Effect.gen(function* () {
 *     yield* devBox.startSandbox();
 *     const test = yield* devBox.exec("git pull && pnpm test", { cwd: "/home/daytona/repo" });
 *     return yield* HttpServerResponse.json(test);
 *   }),
 * };
 * ```
 *
 * ### Putting a Worker in Front of a Port
 * **Example:** Proxy every request to the dev server on port 3000
 * ```typescript
 * const devBox = yield* Daytona.ConnectSandbox(DevBox);
 * return {
 *   fetch: Effect.gen(function* () {
 *     const port = yield* devBox.getTcpPort(3000);
 *     return yield* port.fetch(yield* HttpServerRequest);
 *   }),
 * };
 * ```
 *
 * ### Streaming a Terminal
 * Terminals, code interpreter runs and followed logs stream over a
 * WebSocket, so they work from a Worker too.
 *
 * **Example:** Run a script in a terminal and stream its output
 * ```typescript
 * const output = yield* Effect.scoped(
 *   Effect.gen(function* () {
 *     const pty = yield* devBox.process.createPty({ id: "build" });
 *     yield* pty.write("pnpm build; exit\n");
 *     return yield* pty.output.pipe(Stream.decodeText(), Stream.mkString);
 *   }),
 * );
 * ```
 *
 * ### Forking a Dev Box
 * Daytona forks `linux-vm` sandboxes; a container's fork fails with
 * `ForkNotSupported`.
 *
 * **Example:** Fork it per pull request
 * ```typescript
 * const fork = yield* devBox.forkSandbox({ name: `pr-${number}` });
 * ```
 *
 * @binding
 * @product Sandbox
 */
export interface ConnectSandbox extends Binding.Service<
  ConnectSandbox,
  "Daytona.ConnectSandbox",
  (sandbox: Sandbox) => Effect.Effect<ConnectedSandbox>
> {}

export const ConnectSandbox = Binding.Service<ConnectSandbox>("Daytona.ConnectSandbox");
