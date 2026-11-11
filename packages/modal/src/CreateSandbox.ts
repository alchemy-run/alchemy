import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { App } from "./App.ts";
import type { Image } from "./Image.ts";
import type { ErrorOf } from "./internal.ts";
import type { Sandbox } from "./Sandbox.ts";
import type {
  createPersistentSandbox,
  createSandbox,
  listSandboxes,
  PersistentSandboxCreateOptions,
  PersistentSandboxHandle,
  restoreSandbox,
  SandboxCreateOptions,
  SandboxHandle,
  sandboxFromName,
  SandboxOpError,
} from "./SandboxClient.ts";

export type {
  ExecOptions,
  PersistentSandboxCreateOptions,
  PersistentSandboxHandle,
  ExecResult,
  HeaderReplacement,
  SandboxCreateOptions,
  SandboxFileEntry,
  SandboxHandle,
  SandboxTunnel,
} from "./SandboxClient.ts";

/** A sandbox as `list` reports it. */
export interface SandboxSummary {
  readonly sandboxId: string;
  readonly name: string | undefined;
  readonly createdAt: number | undefined;
  readonly tags: Record<string, string>;
}

/** Sandbox cost for one combination of tag values. */
export interface SandboxUsageGroup {
  /** The grouped tags' values. */
  readonly tags: Record<string, string>;
  /** Total cost in USD. */
  readonly cost: number;
  /** Cost by resource (`cpu`, `memory`, `gpu`, ...). */
  readonly costByResource: Record<string, number>;
}

/** Create and find sandboxes in one App. Every handle method calls Modal. */
export interface SandboxesClient {
  /** The App sandboxes are created in. */
  readonly appId: Effect.Effect<string>;
  /** Create a sandbox. Modal's own sandbox parameters; the bound image is the default `image`. */
  create(
    options?: SandboxCreateOptions,
  ): Effect.Effect<SandboxHandle, ErrorOf<typeof createSandbox>, RuntimeContext>;
  /** A running sandbox by name, or `undefined`. */
  fromName(
    name: string,
  ): Effect.Effect<SandboxHandle | undefined, ErrorOf<typeof sandboxFromName>, RuntimeContext>;
  /** A sandbox by id. */
  fromId(sandboxId: string): Effect.Effect<SandboxHandle>;
  /** Running sandboxes of the App, optionally filtered by tags. */
  list(options?: {
    readonly tags?: Record<string, string>;
    readonly includeFinished?: boolean;
  }): Effect.Effect<ReadonlyArray<SandboxSummary>, ErrorOf<typeof listSandboxes>, RuntimeContext>;
  /**
   * Create a persistent sandbox: one box whose filesystem outlives its
   * sessions. Each session runs up to an hour and pauses after five idle
   * minutes; `session()` resumes it from where it stopped.
   */
  createPersistent(
    options?: PersistentSandboxCreateOptions,
  ): Effect.Effect<
    PersistentSandboxHandle,
    ErrorOf<typeof createPersistentSandbox>,
    RuntimeContext
  >;
  /** A persistent sandbox by id (a `Modal.PersistentSandbox`, or one `createPersistent` made). */
  persistent(
    box: string | { readonly persistentSandboxId: string },
  ): Effect.Effect<PersistentSandboxHandle>;
  /**
   * What the App's sandboxes cost over a time range, grouped by tag values
   * (`groupByTags: ["user"]` gives one group per user). Modal reports
   * whole hours: `since` rounds down and `until` (default now) up to the
   * hour.
   */
  usage(query: {
    readonly since: Date | string | number;
    readonly until?: Date | string | number;
    readonly groupByTags?: ReadonlyArray<string>;
    readonly tags?: Record<string, string>;
  }): Effect.Effect<ReadonlyArray<SandboxUsageGroup>, SandboxOpError<"usage">, RuntimeContext>;
  /** Start a new sandbox from a memory snapshot (`handle.snapshotMemory()`). */
  restore(
    snapshot: { readonly snapshotId: string },
    options?: { readonly name?: string },
  ): Effect.Effect<
    SandboxHandle,
    ErrorOf<typeof restoreSandbox> | SandboxOpError<"setTags">,
    RuntimeContext
  >;
}

/**
 * Create and drive Modal Sandboxes from any runtime: a Worker, a Lambda, a
 * Durable Object, or a script.
 *
 * Bind it to an App (sandboxes boot from the image you pass to `create`) or
 * to an Image (it is the default image, and sandboxes go in the image's
 * App). A sandbox lives at most 24 hours; to keep work across sandboxes, use
 * a Volume, or snapshot it (`snapshotFilesystem`, `snapshotMemory`) and
 * start the next one from the snapshot.
 *
 * Sandboxes are runtime objects: they aren't in Alchemy state. Stopping the
 * App (destroying the `Modal.App` resource) terminates every sandbox in it.
 *
 * Objects created at run time are tagged with the stack, stage and binding
 * (`alchemy::stack`, `alchemy::stage`, `alchemy::id`) and are not deleted when
 * the stack is destroyed. List them by those tags to clean them up:
 * `sandboxes.list({ tags: { "alchemy::stack": "my-app" } })`, or Modal's
 * `SandboxList` with `tags`. Your own `tags` merge under the three. A
 * persistent sandbox takes neither tags nor a name, so it carries no owner;
 * it lives in the App.
 *
 * ### Create a sandbox per request
 * **Example:** Run a command and terminate
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Modal from "@alchemy.run/modal";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import { Warm } from "./Coder.ts";
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const sandboxes = yield* Modal.CreateSandbox(Warm);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const sandbox = yield* Effect.acquireRelease(
 *           sandboxes.create({ timeout: "10 minutes" }),
 *           (sandbox) => Effect.ignore(sandbox.terminate()),
 *         );
 *         const test = yield* sandbox.exec(["pnpm", "test"], { cwd: "/work" });
 *         return yield* HttpServerResponse.json(test);
 *       }).pipe(Effect.scoped, Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Modal.CreateSandboxHttp)),
 * ) {}
 * ```
 *
 * ### One sandbox per session
 * **Example:** Find it by name, else create it
 * ```typescript
 * const sandbox =
 *   (yield* sandboxes.fromName(`session-${user}`)) ??
 *   (yield* sandboxes.create({ name: `session-${user}`, idleTimeout: "10 minutes" }));
 * ```
 *
 * ### Secrets the sandbox never sees
 * **Example:** Inject an API key into outbound requests
 * ```typescript
 * // construction phase: read the Secret's id
 * const openaiId = yield* (yield* OpenAI).secretId;
 * // in a handler
 * const openai = { secretId: yield* openaiId };
 * const sandbox = yield* sandboxes.create({
 *   outboundPolicy: {
 *     routes: [
 *       {
 *         https: {
 *           domains: ["api.openai.com"],
 *           headerReplacements: [{ secret: openai, headers: { Authorization: "Bearer $OPENAI_API_KEY" } }],
 *         },
 *       },
 *       { any: { redirect: "block" } },
 *     ],
 *   },
 * });
 * ```
 *
 * ### A cloud identity, not a key
 * **Example:** Assume an AWS role with the token Modal signs
 * ```typescript
 * const sandbox = yield* sandboxes.create({
 *   image: "amazon/aws-cli",
 *   includeOidcIdentityToken: true,
 * });
 * // MODAL_IDENTITY_TOKEN is an OIDC token from https://oidc.modal.com
 * const role = yield* sandbox.exec(
 *   `aws sts assume-role-with-web-identity --role-arn ${roleArn} --role-session-name sandbox --web-identity-token "$MODAL_IDENTITY_TOKEN"`,
 * );
 * ```
 *
 * ### Persistent sandboxes
 * **Example:** A box per user that keeps its files between sessions
 * ```typescript
 * const box = yield* sandboxes.createPersistent({ image: "node:22-bookworm" });
 * const session = yield* box.session();
 * yield* session.exec("echo hi >> /root/notes.txt");
 * // later, from any request: resumes the box if it paused
 * const again = yield* (yield* sandboxes.persistent(box.persistentSandboxId)).session();
 * ```
 *
 * ### Snapshots
 * **Example:** Save a warmed sandbox and boot the next one from it
 * ```typescript
 * yield* sandbox.exec(["pnpm", "install"], { cwd: "/work" });
 * const image = yield* sandbox.snapshotFilesystem();
 * const next = yield* sandboxes.create({ image });
 * ```
 *
 * @binding
 * @product Sandbox
 */
export interface CreateSandbox extends Binding.Service<
  CreateSandbox,
  "Modal.CreateSandbox",
  (target: App | Image | Sandbox) => Effect.Effect<SandboxesClient>
> {}

export const CreateSandbox = Binding.Service<CreateSandbox>("Modal.CreateSandbox");
