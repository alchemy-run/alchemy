import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as SandboxApi from "alchemy/Sandbox";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";

/**
 * What a harness needs from a sandbox: commands run to completion, and a
 * background command whose output can be followed. Every Alchemy sandbox
 * handle (E2B, Daytona, Modal, Boat, Archil) has both.
 */
export interface SandboxHandle {
  exec(
    command: SandboxApi.Command,
    options?: any,
  ): Effect.Effect<{ readonly exitCode: number | undefined }, unknown, RuntimeContext>;
  start(
    command: SandboxApi.Command,
    options?: any,
  ): Effect.Effect<
    {
      readonly output: Stream.Stream<SandboxApi.ProcessOutput, unknown, RuntimeContext>;
      kill(): Effect.Effect<unknown, unknown, RuntimeContext>;
    },
    unknown,
    RuntimeContext | Scope.Scope
  >;
}

/**
 * Where a harness's tools find files and a shell. The harness chooses a
 * `key` for each sandbox it wants (Pi uses one per conversation) and the
 * Layer maps that key to a sandbox on its platform. A key is lowercase
 * letters, digits and `-`, at most 48 characters, so it is usable as a
 * name or a label on every platform.
 *
 * All three operations are idempotent. `open` returns the key's sandbox
 * running, whatever state it was in: it creates it, resumes it, or returns
 * it as it is. `suspend` stops paying for compute and keeps the files where
 * the platform can; where it cannot, it does nothing. `remove` deletes the
 * sandbox and does nothing when it is already gone.
 *
 * Whether files outlive an idle sandbox is the platform's: a sandbox its
 * platform deleted is created again, empty, by the next `open`.
 *
 * A harness whose tools need files or a shell requires this service, so
 * that harness does not compile until a Layer is provided. Changing
 * platform is providing a different Layer.
 *
 * **Example:** E2B: found by metadata, paused on suspend
 * ```typescript
 * const E2BSandbox = Layer.effect(
 *   AI.Sandbox,
 *   Effect.gen(function* () {
 *     const base = yield* E2B.Template("Base", { image: "node:22-bookworm" });
 *     const sandboxes = yield* E2B.CreateSandbox(base);
 *     const find = (key: string) =>
 *       sandboxes.list({ metadata: { key }, state: ["running", "paused"] });
 *
 *     return {
 *       open: Effect.fn(function* (key) {
 *         const [existing] = yield* find(key);
 *         return existing
 *           ? yield* sandboxes.connect(existing.sandboxID)
 *           : yield* sandboxes.create({ metadata: { key }, timeout: 600, autoPause: true });
 *       }),
 *       suspend: Effect.fn(function* (key) {
 *         const [existing] = yield* find(key);
 *         if (existing?.state !== "running") return;
 *         const sandbox = yield* sandboxes.connect(existing.sandboxID);
 *         yield* sandbox.pause();
 *       }),
 *       remove: Effect.fn(function* (key) {
 *         const found = yield* find(key);
 *         yield* Effect.forEach(found, (sandbox) => sandboxes.kill(sandbox.sandboxID));
 *       }),
 *     };
 *   }),
 * ).pipe(Layer.provide(E2B.CreateSandboxHttp));
 * ```
 *
 * **Example:** Modal: found by name, nothing to suspend
 * ```typescript
 * const ModalSandbox = Layer.effect(
 *   AI.Sandbox,
 *   Effect.gen(function* () {
 *     const app = yield* Modal.App("App", {});
 *     const base = yield* Modal.Image("Base", { app, image: "node:22-bookworm" });
 *     const sandboxes = yield* Modal.CreateSandbox(base);
 *
 *     return {
 *       open: Effect.fn(function* (key) {
 *         return (
 *           (yield* sandboxes.fromName(key)) ??
 *           (yield* sandboxes.create({ name: key, idleTimeout: "10 minutes" }))
 *         );
 *       }),
 *       // Modal has no pause: it ends the sandbox once it is idle.
 *       suspend: () => Effect.void,
 *       remove: Effect.fn(function* (key) {
 *         const sandbox = yield* sandboxes.fromName(key);
 *         if (sandbox !== undefined) yield* sandbox.terminate();
 *       }),
 *     };
 *   }),
 * ).pipe(Layer.provide(Modal.CreateSandboxHttp));
 * ```
 */
export class Sandbox extends Context.Service<
  Sandbox,
  {
    /** The key's sandbox, running: created, resumed, or returned as it is. */
    readonly open: (key: string) => Effect.Effect<SandboxHandle, unknown, RuntimeContext>;
    /** Stop the key's sandbox and keep its files, where the platform can. */
    readonly suspend: (key: string) => Effect.Effect<unknown, unknown, RuntimeContext>;
    /** Delete the key's sandbox, if there is one. */
    readonly remove: (key: string) => Effect.Effect<unknown, unknown, RuntimeContext>;
  }
>()("AI.Sandbox") {}
