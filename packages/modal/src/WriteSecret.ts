import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import type { OpError } from "./internal.ts";
import type { Secret } from "./Secret.ts";
import type { WriteSecretOps } from "./WriteSecretHttp.ts";

/** Replace one secret's variables. */
export interface WriteSecretClient {
  readonly secretId: Effect.Effect<string>;
  /**
   * Replace the secret's whole variable set. Sandboxes and functions started
   * afterwards see the new values; running ones keep theirs.
   */
  put(
    env: Record<string, string | Redacted.Redacted<string>>,
  ): Effect.Effect<void, OpError<WriteSecretOps, "getInfo" | "update">, RuntimeContext>;
}

/**
 * Rotate a Modal Secret from any runtime. Modal never returns secret
 * values, so there is no read binding: attach the secret to a sandbox
 * instead, or inject it with an outbound header replacement.
 *
 * ### Rotate a secret
 * **Example:** From a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Modal from "@alchemy.run/modal";
 * import * as Effect from "effect/Effect";
 * import * as Redacted from "effect/Redacted";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import { OpenAI } from "./Storage.ts";
 *
 * export default class Rotate extends Cloudflare.Worker<Rotate>()(
 *   "Rotate",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const openai = yield* Modal.WriteSecret(OpenAI);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* openai.put({ OPENAI_API_KEY: Redacted.make("sk-new") });
 *         return HttpServerResponse.text("rotated");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Modal.WriteSecretHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Secret
 */
export interface WriteSecret extends Binding.Service<
  WriteSecret,
  "Modal.WriteSecret",
  (secret: Secret) => Effect.Effect<WriteSecretClient>
> {}

export const WriteSecret = Binding.Service<WriteSecret>("Modal.WriteSecret");
