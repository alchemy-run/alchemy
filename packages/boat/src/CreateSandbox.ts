import type * as boat from "@distilled.cloud/boat-dev/boat";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Duration from "effect/Duration";
import type * as Effect from "effect/Effect";
import type { BoatError, BoatSandbox } from "./SandboxClient.ts";
import type { Snapshot } from "./Snapshot.ts";

/**
 * Boat's `createSandbox` parameters, with `autoStop` in place of
 * `ttlSeconds`. `from` defaults to the bound snapshot; `labels` are merged
 * under the host's ownership labels.
 */
export type CreateSandboxOptions = Omit<boat.CreateSandboxRequest, "count" | "ttlSeconds"> & {
  /**
   * How long the sandbox runs before Boat stops it, saving its disk;
   * `false` never stops it.
   * @default "1 hour"
   */
  readonly autoStop?: Duration.Input | false;
};

/** Boat's `listSandboxes` filters, with `labels` as a record. */
export interface ListSandboxesOptions {
  /** Only sandboxes with all of these labels. */
  readonly labels?: Readonly<Record<string, string>>;
  /** Only sandboxes in these states, e.g. `["ready", "idle", "running"]`. */
  readonly state?: ReadonlyArray<boat.SandboxState>;
}

/** Boat sandboxes: create, connect to, list and delete them. */
export interface SandboxesClient {
  /** Creates a sandbox, from the bound snapshot unless `from` says otherwise. */
  create(options?: CreateSandboxOptions): Effect.Effect<BoatSandbox, BoatError, RuntimeContext>;
  /** A handle to an existing sandbox. */
  connect(sandboxId: string): Effect.Effect<BoatSandbox, BoatError, RuntimeContext>;
  /** A sandbox's details. */
  get(sandboxId: string): Effect.Effect<boat.Sandbox, BoatError, RuntimeContext>;
  /** Sandboxes, filtered by labels or state. */
  list(
    options?: ListSandboxesOptions,
  ): Effect.Effect<ReadonlyArray<boat.Sandbox>, BoatError, RuntimeContext>;
  /**
   * Deletes a sandbox this host created, with its disk. Deleting one that
   * is gone succeeds.
   */
  delete(sandboxId: string): Effect.Effect<void, BoatError, RuntimeContext>;
}

/**
 * Create and manage Boat sandboxes from a Worker, Function or any other
 * host.
 *
 * `Boat.CreateSandbox(snapshot)` creates sandboxes from a snapshot declared
 * in the stack; `Boat.CreateSandbox()` creates them from scratch, or from
 * the `from` each call passes. Both return the same client, whose calls take
 * Boat's own parameters.
 *
 * Sandboxes created at run time are labelled with the stack, stage and
 * host (`alchemy.stack`, `alchemy.stage`, `alchemy.id`) and are not deleted
 * when the stack is destroyed. List them by those labels to clean them up:
 * `sandboxes.list({ labels: { "alchemy.stack": "my-app", "alchemy.stage": "prod" } })`.
 * Labels you pass to `create` merge underneath; they never replace the
 * `alchemy.*` ones.
 *
 * The host gets its own Boat API key, minted at deploy and revoked when the
 * host is destroyed. It may create sandboxes and work in them, and delete
 * only the sandboxes it created; it can't touch the account's other
 * sandboxes, environments, keys or billing.
 *
 * ### Creating sandboxes
 * **Example:** One sandbox per request, deleted when the request ends
 * ```typescript
 * const sandboxes = yield* Boat.CreateSandbox();
 * // in fetch:
 * const sandbox = yield* Effect.acquireRelease(
 *   sandboxes.create({ type: "small", noEnv: true, autoStop: "10 minutes" }),
 *   (sandbox) => Effect.ignore(sandbox.delete()),
 * );
 * const result = yield* sandbox.exec("node --version");
 * ```
 *
 * **Example:** From a snapshot declared in the stack
 * ```typescript
 * const sandboxes = yield* Boat.CreateSandbox(Golden);
 * const sandbox = yield* sandboxes.create();
 * ```
 *
 * **Example:** A long-lived sandbox per task, found by label
 * ```typescript
 * const [existing] = yield* sandboxes.list({ labels: { task } });
 * const sandbox = existing
 *   ? yield* sandboxes.connect(existing.id)
 *   : yield* sandboxes.create({ labels: { task }, autoStop: "30 minutes" });
 * ```
 *
 * ### Running commands
 * `exec` runs to completion and returns `{ exitCode, stdout, stderr }`; a
 * non-zero exit is returned, not failed. A string runs in a shell, an
 * array runs its arguments quoted.
 *
 * **Example:** A shell line, an argument vector, stdin and a timeout
 * ```typescript
 * const test = yield* sandbox.exec("npm test", { cwd: "/home/user/app" });
 * const version = yield* sandbox.exec(["node", "--version"]);
 * const sorted = yield* sandbox.exec("sort", { stdin: "b\na\n" });
 * const slow = yield* sandbox.exec("make", { timeout: "2 minutes" }); // Boat.ExecTimedOut
 * ```
 *
 * **Example:** Start a server in the background and stream its output
 * ```typescript
 * const server = yield* sandbox.start("npm run dev", { cwd: "/home/user/app" });
 * yield* server.output.pipe(
 *   Stream.take(5),
 *   Stream.runForEach((chunk) => Effect.log(new TextDecoder().decode(chunk.data))),
 * );
 * ```
 *
 * ### Calling a port
 * **Example:** Proxy the Worker's request to port 3000
 * ```typescript
 * const port = yield* sandbox.getTcpPort(3000);
 * return yield* port.fetch(yield* HttpServerRequest);
 * ```
 *
 * ### Forking and snapshots
 * **Example:** Save a sandbox and fork it
 * ```typescript
 * yield* sandbox.stop(); // stopping snapshots it
 * const copy = yield* sandbox.fork({ autoStop: "10 minutes" });
 * yield* sandbox.resume();
 * ```
 *
 * @binding
 * @product Sandbox
 */
export interface CreateSandbox extends Binding.Service<
  CreateSandbox,
  "Boat.CreateSandbox",
  (base?: Snapshot) => Effect.Effect<SandboxesClient>
> {}

export const CreateSandbox = Binding.Service<CreateSandbox>("Boat.CreateSandbox");
