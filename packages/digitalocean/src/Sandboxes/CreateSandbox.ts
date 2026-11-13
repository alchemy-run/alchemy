import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import type { SandboxSize } from "./internal.ts";
import type { SandboxBindingNotConfigured, SandboxError } from "./SandboxClient.ts";
import type { Template } from "./Template.ts";

/** Options for one sandbox. */
export interface CreateSandboxOptions {
  /** MicroVM name. @default `sandbox-<random>` */
  readonly name?: string;
  /** Environment variables for processes in the sandbox. */
  readonly env?: Record<string, string>;
  /** Port an HTTP server in the sandbox listens on, exposed at `url`. */
  readonly httpPort?: number;
  /** Pause after this many idle seconds; a request to `url` resumes it. */
  readonly autoPauseSeconds?: number;
  /** vCPUs and memory (MiB). @default the template's */
  readonly size?: SandboxSize;
}

/** The result of a command: a non-zero exit is returned, not failed. */
export interface ExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** A running MicroVM sandbox. */
export interface SandboxHandle {
  readonly sandboxId: string;
  /** Public URL of `httpPort`, when one is exposed. */
  readonly url: string | undefined;
  /** Runs a shell line (string) or an argument vector (array) to completion. */
  exec(
    command: string | ReadonlyArray<string>,
    options?: { readonly cwd?: string },
  ): Effect.Effect<ExecResult, SandboxError, RuntimeContext>;
  /** Pauses the MicroVM, keeping its memory and disk. */
  readonly pause: Effect.Effect<void, SandboxError, RuntimeContext>;
  /** Resumes a paused MicroVM. */
  readonly resume: Effect.Effect<void, SandboxError, RuntimeContext>;
  /** Deletes the MicroVM. Deleting one that is gone succeeds. */
  readonly delete: Effect.Effect<void, SandboxError, RuntimeContext>;
}

/** Sandboxes from one base: create, find and delete them. */
export interface SandboxesClient {
  create(
    options?: CreateSandboxOptions,
  ): Effect.Effect<SandboxHandle, SandboxError | SandboxBindingNotConfigured, RuntimeContext>;
  /** A handle to an existing sandbox. */
  get(
    sandboxId: string,
  ): Effect.Effect<SandboxHandle, SandboxError | SandboxBindingNotConfigured, RuntimeContext>;
}

/**
 * Creates DigitalOcean MicroVM sandboxes at run time from a
 * `Sandboxes.Template`, from a Worker, App, Lambda or any other host.
 * Sandboxes boot from the template's checkpoint, so they start with its
 * packages installed.
 *
 * DigitalOcean has no API to create access tokens, so the host cannot get
 * a key of its own. Pass a token you created with only the `microvm`
 * scopes as `token`; it reaches the host as a secret and is never your
 * deploy token.
 *
 * ### Creating sandboxes
 * **Example:** One sandbox per request, deleted when the request ends
 * ```typescript
 * const Base = DigitalOcean.Sandboxes.Template("node", { image: "node:22-bookworm" });
 *
 * export default class Api extends DigitalOcean.App<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const token = yield* Config.Redacted("SANDBOX_TOKEN");
 *     const sandboxes = yield* DigitalOcean.Sandboxes.CreateSandbox(Base, { token });
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const sandbox = yield* Effect.acquireRelease(sandboxes.create(), (s) =>
 *           Effect.ignore(s.delete),
 *         );
 *         const result = yield* sandbox.exec("node --version");
 *         return HttpServerResponse.text(result.stdout);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(DigitalOcean.Sandboxes.CreateSandboxHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Sandboxes
 */
export interface CreateSandbox extends Binding.Service<
  CreateSandbox,
  "DigitalOcean.Sandboxes.CreateSandbox",
  (
    base: Template | string,
    options: { readonly token: Redacted.Redacted<string> },
  ) => Effect.Effect<SandboxesClient>
> {}

export const CreateSandbox = Binding.Service<CreateSandbox>("DigitalOcean.Sandboxes.CreateSandbox");
