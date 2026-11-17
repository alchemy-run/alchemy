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

/** Which conversation a sandbox is for. */
export interface SandboxTarget {
  /**
   * Identifies the harness instance: the Durable Object's id, a SQLite
   * file's path. Conversation ids repeat from one instance to the next, so
   * key the sandbox on both.
   */
  readonly instanceId: string;
  readonly conversationId: string;
  /** The conversation's working directory, when it has one. */
  readonly cwd?: string;
}

/**
 * Where a conversation's files and shell are. `open` finds or creates the
 * conversation's sandbox, and `remove` deletes it. Make `open` idempotent
 * (find by name or metadata first), so the same conversation reaches the
 * same sandbox after its host is evicted or restarted.
 *
 * A harness whose tools need files or a shell requires it, so that harness
 * does not compile until a Layer is provided. The sandbox can be on any
 * platform (E2B, Daytona, Modal, Boat, Archil): changing platform is
 * providing a different Layer.
 *
 * **Example:** One E2B sandbox per conversation
 * ```typescript
 * const E2BSandbox = Layer.effect(
 *   AI.Sandbox,
 *   Effect.gen(function* () {
 *     const base = yield* E2B.Template("Base", { image: "node:22-bookworm" });
 *     const sandboxes = yield* E2B.CreateSandbox(base);
 *     const metadataOf = ({ instanceId, conversationId }: AI.SandboxTarget) => ({
 *       instance: instanceId,
 *       conversation: conversationId,
 *     });
 *     const find = (target: AI.SandboxTarget) =>
 *       sandboxes.list({ metadata: metadataOf(target), state: ["running", "paused"] });
 *
 *     return {
 *       open: Effect.fn(function* (target) {
 *         const [existing] = yield* find(target);
 *         return existing
 *           ? yield* sandboxes.connect(existing.sandboxID)
 *           : yield* sandboxes.create({ metadata: metadataOf(target), timeout: 600 });
 *       }),
 *       remove: Effect.fn(function* (target) {
 *         const found = yield* find(target);
 *         yield* Effect.forEach(found, (sandbox) => sandboxes.kill(sandbox.sandboxID));
 *       }),
 *     };
 *   }),
 * ).pipe(Layer.provide(E2B.CreateSandboxHttp));
 * ```
 *
 * **Example:** The same on Daytona
 * ```typescript
 * const DaytonaSandbox = Layer.effect(
 *   AI.Sandbox,
 *   Effect.gen(function* () {
 *     const base = yield* Daytona.Snapshot("Base", { image: "node:22-bookworm" });
 *     const sandboxes = yield* Daytona.CreateSandbox(base);
 *     const nameOf = ({ instanceId, conversationId }: AI.SandboxTarget) =>
 *       `ai-${instanceId.slice(0, 16)}-${conversationId}`;
 *
 *     return {
 *       open: Effect.fn(function* (target) {
 *         const existing = yield* sandboxes.get(nameOf(target));
 *         if (existing === undefined) {
 *           return yield* sandboxes.create({ name: nameOf(target), autoStopInterval: 15 });
 *         }
 *         yield* existing.startSandbox();
 *         return existing;
 *       }),
 *       remove: (target) => sandboxes.delete(nameOf(target)),
 *     };
 *   }),
 * ).pipe(Layer.provide(Daytona.CreateSandboxHttp));
 * ```
 */
export class Sandbox extends Context.Service<
  Sandbox,
  {
    /** Find or create the conversation's sandbox. */
    readonly open: (target: SandboxTarget) => Effect.Effect<SandboxHandle, unknown, RuntimeContext>;
    /** Delete the conversation's sandbox, if it has one. Its next tool call opens a new one. */
    readonly remove: (target: SandboxTarget) => Effect.Effect<unknown, unknown, RuntimeContext>;
  }
>()("AI.Sandbox") {}
