import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import type { SecretsOps } from "./CreateSecretHttp.ts";
import type { Environment } from "./Environment.ts";
import type { ErrorOf, OpError } from "./internal.ts";
import type { lookupSecret, putSecret } from "./Secret.ts";
import type { SecretAttributes } from "./Secret.ts";

/** Write, find, list and delete secrets by name in one environment. */
export interface SecretsClientOf<R> {
  /**
   * Create or overwrite the secret named `name` with `env`. Returns its
   * attributes, to pass as a sandbox `secrets` entry or in an outbound
   * header replacement.
   */
  put(
    name: string,
    env: Record<string, string | Redacted.Redacted<string>>,
  ): Effect.Effect<SecretAttributes, ErrorOf<typeof putSecret>, R>;
  /** The secret named `name` (its variable names, never its values), or `undefined`. */
  get(name: string): Effect.Effect<SecretAttributes | undefined, ErrorOf<typeof lookupSecret>, R>;
  /** Delete the secret named `name` (no-op when missing). */
  delete(
    name: string,
  ): Effect.Effect<
    void,
    | ErrorOf<typeof lookupSecret>
    | Exclude<OpError<SecretsOps, "delete">, { readonly _tag: "SecretNotFound" }>,
    R
  >;
  /** Names of every secret in the environment. */
  list(): Effect.Effect<ReadonlyArray<string>, OpError<SecretsOps, "list">, R>;
}

/** A SecretsClient whose calls run inside a deployed runtime. */
export type SecretsClient = SecretsClientOf<RuntimeContext>;

/**
 * Store secrets by name at runtime, such as one per user, and hand them to
 * that user's sandboxes. With an outbound header replacement the sandbox
 * never sees the value: Modal adds it to matching requests on the way out.
 *
 * Bind it to a `Modal.Environment` to keep these runtime secrets in their
 * own namespace. They aren't in Alchemy state: deleting the environment
 * removes them.
 *
 * Objects created at run time are tagged with the stack, stage and binding
 * (`alchemy::stack`, `alchemy::stage`, `alchemy::id`) and are not deleted when
 * the stack is destroyed. A Modal secret has only a name, so the tags become
 * its name prefix, `Modal.runtimePrefix({ stack, stage, id })`: list them
 * with `modal secret list` and delete the ones whose name starts with it.
 *
 * ### A user's token, injected at egress
 * **Example:** From a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Modal from "@alchemy.run/modal";
 * import * as Effect from "effect/Effect";
 * import * as Layer from "effect/Layer";
 * import { HttpServerRequest } from "effect/http/HttpServerRequest";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import { Agents, Coder } from "./Coder.ts";
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const secrets = yield* Modal.CreateSecret(Agents);
 *     const sandboxes = yield* Modal.CreateSandbox(Coder);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const request = yield* HttpServerRequest;
 *         const user = request.headers["x-user"] ?? "anonymous";
 *         const github = yield* secrets.put(`github-${user}`, {
 *           GITHUB_TOKEN: request.headers["x-github-token"] ?? "",
 *         });
 *         const sandbox = yield* sandboxes.create({
 *           outboundPolicy: {
 *             routes: [
 *               {
 *                 https: {
 *                   domains: ["api.github.com"],
 *                   headerReplacements: [{ secret: github, headers: { Authorization: "Bearer $GITHUB_TOKEN" } }],
 *                 },
 *               },
 *               { tls: { domains: ["github.com"] } },
 *               { any: { redirect: "block" } },
 *             ],
 *           },
 *         });
 *         return HttpServerResponse.text(sandbox.sandboxId);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Layer.mergeAll(Modal.CreateSecretHttp, Modal.CreateSandboxHttp))),
 * ) {}
 * ```
 *
 * @binding
 * @product Secret
 */
export interface CreateSecret extends Binding.Service<
  CreateSecret,
  "Modal.CreateSecret",
  (environment?: Environment) => Effect.Effect<SecretsClient>
> {}

export const CreateSecret = Binding.Service<CreateSecret>("Modal.CreateSecret");
