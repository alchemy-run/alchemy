import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as SandboxApi from "alchemy/Sandbox";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";

/** A file operation or command in a conversation's sandbox failed. */
export class SandboxError extends Data.TaggedError("SandboxError")<{
  readonly operation: string;
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}> {}

/** What a command printed, and its exit code. */
export interface ExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ExecOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  /** Milliseconds before the command is killed. */
  readonly timeout?: number;
}

/**
 * The sandbox of the conversation a tool call belongs to: its files and
 * its shell. A harness provides it to every tool handler, already scoped
 * to the call's conversation, so a tool never names a sandbox or a
 * conversation. Which platform it runs on is the `AI.Sandboxes` Layer the
 * harness was given.
 *
 * A tool whose handler uses it requires `AI.Sandboxes` where it is
 * provided or listed, so a harness without one does not compile.
 *
 * **Example:** A tool that runs a command in the conversation's sandbox
 * ```typescript
 * export class RunTests extends AI.Tool<RunTests>()("run_tests", {
 *   description: "Run the test suite and report failures.",
 *   parameters: Schema.Struct({ filter: Schema.optional(Schema.String) }),
 *   success: Schema.Struct({ exitCode: Schema.Number, output: Schema.String }),
 *   replay: "safe",
 * }) {}
 *
 * export const RunTestsLive = RunTests.make(
 *   Effect.gen(function* () {
 *     return Effect.fn(function* ({ filter }) {
 *       const sandbox = yield* AI.Sandbox;
 *       const result = yield* sandbox
 *         .exec(["npm", "test", ...(filter ? ["--", filter] : [])])
 *         .pipe(Effect.orDie);
 *       return { exitCode: result.exitCode, output: result.stdout.slice(-8000) };
 *     });
 *   }),
 * );
 * ```
 */
export class Sandbox extends Context.Service<
  Sandbox,
  {
    /** Run a program (an argument vector) or a shell line to completion. */
    readonly exec: (
      command: string | ReadonlyArray<string>,
      options?: ExecOptions,
    ) => Effect.Effect<ExecResult, SandboxError>;
    readonly readFile: (path: string) => Effect.Effect<Uint8Array, SandboxError>;
    readonly readTextFile: (path: string) => Effect.Effect<string, SandboxError>;
    readonly writeFile: (
      path: string,
      content: string | Uint8Array,
    ) => Effect.Effect<void, SandboxError>;
  }
>()("AI.Sandbox") {}

/**
 * What a harness needs from a platform's sandbox: commands run to completion, and a
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
 * The sandboxes a harness gives its conversations. The harness chooses a
 * `key` for each sandbox it wants (Pi uses one per conversation) and the
 * Layer maps that key to a sandbox on its platform. Tools never call it:
 * they use `AI.Sandbox`, which the harness opens from here for the call's
 * conversation. A key is lowercase
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
 *   AI.Sandboxes,
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
 *   AI.Sandboxes,
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
export class Sandboxes extends Context.Service<
  Sandboxes,
  {
    /** The key's sandbox, running: created, resumed, or returned as it is. */
    readonly open: (key: string) => Effect.Effect<SandboxHandle, unknown, RuntimeContext>;
    /** Stop the key's sandbox and keep its files, where the platform can. */
    readonly suspend: (key: string) => Effect.Effect<unknown, unknown, RuntimeContext>;
    /** Delete the key's sandbox, if there is one. */
    readonly remove: (key: string) => Effect.Effect<unknown, unknown, RuntimeContext>;
  }
>()("AI.Sandboxes") {}
