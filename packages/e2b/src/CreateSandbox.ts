import type * as sandboxes from "@distilled.cloud/e2b/sandboxes";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BoundVolumeMount, VolumeMount } from "./MountVolume.ts";
import type { E2BError, E2BSandbox } from "./SandboxClient.ts";
import type { Snapshot } from "./Snapshot.ts";
import type { Template } from "./Template.ts";

/** A template or snapshot sandboxes are created from. */
export type SandboxBase = Template | Snapshot;

/**
 * E2B's `createSandbox` parameters. `templateID` defaults to the bound base;
 * `metadata` is merged with the host's ownership stamp; `mounts` replaces
 * E2B's `volumeMounts`.
 */
export type CreateSandboxOptions = Omit<
  sandboxes.CreateSandboxRequest,
  "templateID" | "volumeMounts"
> & {
  readonly templateID?: string;
  /**
   * Volumes to mount: a volume `CreateVolume` returned with a `path`, or a
   * reference from `E2B.MountVolume`. A bound template's own mounts are
   * added.
   */
  readonly mounts?: ReadonlyArray<VolumeMount | BoundVolumeMount>;
};

/** E2B's `listSandboxes` filters, with `metadata` as a record instead of a query string. */
export type ListSandboxesOptions = Omit<
  sandboxes.ListSandboxesRequest,
  "metadata" | "nextToken"
> & {
  readonly metadata?: Readonly<Record<string, string>>;
};

/** E2B sandboxes: create, look up, list and kill them. */
export interface SandboxesClient {
  /** Creates a sandbox from the bound base (or `templateID`). */
  create(options?: CreateSandboxOptions): Effect.Effect<E2BSandbox, E2BError, RuntimeContext>;
  /**
   * A handle to an existing sandbox. A paused sandbox is resumed; `timeout`
   * (seconds) resets its lifetime.
   */
  connect(
    sandboxId: string,
    options?: { readonly timeout?: number; readonly memory?: boolean },
  ): Effect.Effect<E2BSandbox, E2BError, RuntimeContext>;
  /** A sandbox's details, without resuming it. */
  get(sandboxId: string): Effect.Effect<sandboxes.SandboxDetail, E2BError, RuntimeContext>;
  /** Sandboxes, filtered by metadata, state or template (the bound base by default). */
  list(
    options?: ListSandboxesOptions,
  ): Effect.Effect<ReadonlyArray<sandboxes.ListedSandbox>, E2BError, RuntimeContext>;
  /** Kills a sandbox. Killing one that is gone succeeds. */
  kill(sandboxId: string): Effect.Effect<void, E2BError, RuntimeContext>;
  /** The latest CPU, memory and disk metrics of several sandboxes at once, by id. */
  metrics(
    sandboxIds: ReadonlyArray<string>,
  ): Effect.Effect<sandboxes.SandboxesWithMetrics, E2BError, RuntimeContext>;
}

/**
 * Create and manage E2B sandboxes from a Worker, Function or any other host.
 *
 * `E2B.CreateSandbox(base)` creates sandboxes from a template or snapshot
 * declared in the stack; `E2B.CreateSandbox()` takes the template per call.
 * Both return the same client, whose calls take E2B's own parameters.
 *
 * Sandboxes created at run time are tagged with the stack, stage and
 * binding (`alchemy::stack`, `alchemy::stage`, `alchemy::id` in their E2B
 * metadata) and are not deleted when the stack is destroyed. List them by
 * those tags to clean them up:
 * `sandboxes.list({ metadata: { "alchemy::stack": "my-app", "alchemy::stage": "prod" } })`.
 * Metadata you pass to `create` merges underneath; it never replaces the
 * `alchemy::*` keys.
 *
 * The host gets its own E2B API key, minted at deploy and revoked when the
 * host is destroyed. E2B keys are not scoped, so the key reaches the whole
 * team; it is never the deployer's own.
 *
 * ### Creating sandboxes
 * **Example:** One sandbox per request, killed when the request ends
 * ```typescript
 * const sandboxes = yield* E2B.CreateSandbox(Agent);
 * // in fetch:
 * const sandbox = yield* Effect.acquireRelease(
 *   sandboxes.create({ timeout: 120 }),
 *   (sandbox) => Effect.ignore(sandbox.kill()),
 * );
 * const result = yield* sandbox.exec("node --version");
 * ```
 *
 * **Example:** A long-lived sandbox per task, found by metadata
 * ```typescript
 * const [existing] = yield* sandboxes.list({ metadata: { task }, state: ["running", "paused"] });
 * const sandbox = existing
 *   ? yield* sandboxes.connect(existing.sandboxID)
 *   : yield* sandboxes.create({ metadata: { task }, autoPause: true, timeout: 1800 });
 * ```
 *
 * ### Running commands
 * `exec` runs to completion and returns `{ exitCode, stdout, stderr }`; a
 * non-zero exit is returned, not failed. A string runs in a login shell, an
 * array runs directly.
 *
 * **Example:** A shell line, an argument vector, stdin and a timeout
 * ```typescript
 * const test = yield* sandbox.exec("npm test", { cwd: "/home/user/app" });
 * const version = yield* sandbox.exec(["node", "--version"]);
 * const sorted = yield* sandbox.exec("sort", { stdin: "b\na\n" });
 * const slow = yield* sandbox.exec("make", { timeout: "2 minutes" }); // E2B.ExecTimedOut
 * ```
 *
 * **Example:** Stream a process, then wait for it
 * ```typescript
 * const build = yield* sandbox.start("npm run build", { cwd: "/home/user/app" });
 * yield* build.output.pipe(
 *   Stream.runForEach((chunk) => Effect.log(new TextDecoder().decode(chunk.data))),
 * );
 * const { exitCode } = yield* build.wait;
 * ```
 *
 * Closing the scope detaches: the process keeps running, and
 * `sandbox.processes.attach({ pid })` picks it up again.
 *
 * **Example:** A terminal
 * ```typescript
 * const pty = yield* sandbox.pty.open({ cols: 120, rows: 40 });
 * yield* pty.write("ls\n");
 * yield* pty.resize({ cols: 160, rows: 48 });
 * ```
 *
 * ### Network and secrets
 * **Example:** Allow only GitHub and inject a token at egress
 * ```typescript
 * const github = yield* GitHubToken;
 * const sandbox = yield* sandboxes.create({
 *   network: {
 *     allowOut: ["github.com", "*.github.com"],
 *     rules: { "api.github.com": [{ transform: { headers: { Authorization: `Bearer ${github.ref}` } } }] },
 *   },
 * });
 * ```
 *
 * @binding
 * @product Sandbox
 */
export interface CreateSandbox extends Binding.Service<
  CreateSandbox,
  "E2B.CreateSandbox",
  (base?: SandboxBase) => Effect.Effect<SandboxesClient>
> {}

export const CreateSandbox = Binding.Service<CreateSandbox>("E2B.CreateSandbox");
