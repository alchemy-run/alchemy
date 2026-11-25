import * as MuxRetry from "@distilled.cloud/mux/Retry";
import * as System from "@distilled.cloud/mux/system";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { redact } from "../internal/redact.ts";
import type { Providers } from "../Providers.ts";

export interface SigningKeyProps {}

export interface SigningKeyAttributes {
  /** Mux signing key ID, the `kid` of every token the key signs. */
  id: string;
  /** Unix timestamp (seconds, as a string) of creation. */
  created_at: string;
  /**
   * Base64-encoded PEM of the RSA private key that signs playback,
   * thumbnail and DRM license tokens. Mux returns it only when the key is
   * created, so it lives in Alchemy state. A key found through `list` has
   * an empty private key.
   */
  private_key: Redacted.Redacted<string>;
}

export type SigningKey = Resource<
  "Mux.System.SigningKey",
  SigningKeyProps,
  SigningKeyAttributes,
  never,
  Providers
>;

/**
 * A Mux URL signing key: the RSA key pair that signs tokens for `signed`
 * and `drm` playback IDs. Mux keeps the public half and returns the private
 * half once, at creation. Needs a token with System write.
 *
 * A signing key has no settings, so it is never updated. Deleting it
 * invalidates every token it signed.
 * @see https://www.mux.com/docs/guides/secure-video-playback
 *
 * ### Creating a Signing Key
 * **Example:** One key for the stack
 * ```typescript
 * const key = yield* Mux.System.SigningKey("Playback");
 * ```
 *
 * ### Signing playback tokens
 * Bind the key to a runtime with `Mux.Video.PlaybackSigner`, which carries
 * the private key to the host as a secret.
 *
 * **Example:** Mint a token in a request handler
 * ```typescript
 * const key = yield* Mux.System.SigningKey("Playback");
 * const signer = yield* Mux.Video.PlaybackSigner(key);
 * // in a request handler, for a signed playback ID:
 * const token = yield* signer.sign("PLAYBACK_ID", { expiresIn: 600 });
 * ```
 *
 * @resource
 */
export const SigningKey = Resource<SigningKey>("Mux.System.SigningKey");

const NO_KEY = Redacted.make("");

const toAttrs = (
  key: System.SigningKey,
  private_key: Redacted.Redacted<string>,
): SigningKeyAttributes => ({ id: key.id, created_at: key.created_at, private_key });

export const SigningKeyProvider = () =>
  Provider.effect(
    SigningKey,
    Effect.gen(function* () {
      const create = yield* System.createSigningKey;
      const del = yield* System.deleteSigningKey;
      const list = yield* System.listSigningKeys;

      const all = list.items({ limit: 100 }).pipe(Stream.runCollect);
      // After a delete, GET on the key can keep answering 200 for minutes if
      // the key was read before; the list drops it at once.
      const exists = (id: string) => all.pipe(Effect.map((keys) => keys.some((k) => k.id === id)));

      return {
        stables: ["id", "created_at", "private_key"],
        list: () => all.pipe(Effect.map((keys) => keys.map((key) => toAttrs(key, NO_KEY)))),
        reconcile: Effect.fn(function* ({ output }) {
          if (output?.id && (yield* exists(output.id))) return output;
          // A create that failed with a 5xx may still have happened, so it
          // is retried only on throttling.
          const { data } = yield* create({}).pipe(MuxRetry.throttling);
          return toAttrs(data, redact(data.private_key));
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* del({ SIGNING_KEY_ID: output.id }).pipe(
            Effect.catchTag("NotFound", () => Effect.void),
          );
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output?.id) return undefined;
          return (yield* exists(output.id)) ? output : undefined;
        }),
      };
    }),
  );
