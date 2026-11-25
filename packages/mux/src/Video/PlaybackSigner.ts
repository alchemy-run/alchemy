import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { bindHostEnv } from "../internal/hostEnv.ts";
import type { SigningKey } from "../System/SigningKey.ts";

/** What a token unlocks: `aud` `v`, `t`, `g`, `s` or `d`. */
export type TokenType = "video" | "thumbnail" | "gif" | "storyboard" | "drm_license";

const AUDIENCE: Record<TokenType, string> = {
  video: "v",
  thumbnail: "t",
  gif: "g",
  storyboard: "s",
  drm_license: "d",
};

export interface SignOptions {
  /**
   * What the token unlocks.
   * @default "video"
   */
  type?: TokenType;
  /**
   * Lifetime in seconds.
   * @default 3600
   */
  expiresIn?: number;
  /** A `Mux.Video.PlaybackRestriction` id the token enforces. */
  playbackRestrictionId?: string;
  /** Extra claims, such as thumbnail `time` or `width`, or `custom` data for Mux Data. */
  claims?: Record<string, unknown>;
}

/** A playback token could not be signed. */
export class PlaybackTokenError extends Data.TaggedError("Mux.PlaybackTokenError")<{
  readonly reason: string;
  readonly cause?: unknown;
}> {
  override get message() {
    return `Mux playback token not signed: ${this.reason}`;
  }
}

export interface PlaybackSignerClient {
  /**
   * A JWT for `?token=` on `stream.mux.com` or `image.mux.com`, signed with
   * the bound signing key.
   */
  sign: (
    playbackId: string,
    options?: SignOptions,
  ) => Effect.Effect<string, PlaybackTokenError, RuntimeContext>;
}

/**
 * Mints signed playback, thumbnail, GIF, storyboard and DRM license tokens
 * in a runtime, with a `Mux.System.SigningKey`'s private key. The key id and
 * private key reach the host through its environment when it deploys, the
 * private key as a secret. Signing happens in the runtime with WebCrypto, so
 * it calls no Mux API and needs no Mux access token: Mux signs no workload
 * identity a host could use instead, and checks tokens only by the key.
 * @see https://www.mux.com/docs/guides/secure-video-playback
 *
 * **Example:** Sign playback URLs in a Docker service
 * ```typescript
 * const Key = Mux.System.SigningKey("Playback");
 *
 * export default class Api extends Docker.Service<Api>()(
 *   "Api",
 *   { main: import.meta.filename, port: 3000 },
 *   Effect.gen(function* () {
 *     const key = yield* Key;
 *     const signer = yield* Mux.Video.PlaybackSigner(key);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const request = yield* HttpServerRequest;
 *         const playbackId = new URL(request.url, "http://api").searchParams.get("id") ?? "";
 *         const token = yield* signer.sign(playbackId, { expiresIn: 600 });
 *         return HttpServerResponse.text(
 *           `https://stream.mux.com/${playbackId}.m3u8?token=${token}`,
 *         );
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Mux.Video.PlaybackSignerLive)),
 * ) {}
 * ```
 *
 * Without a binding, `signPlaybackToken` signs with a key you pass yourself.
 *
 * @binding
 */
export interface PlaybackSigner extends Binding.Service<
  PlaybackSigner,
  "Mux.Video.PlaybackSigner",
  (key: SigningKey) => Effect.Effect<PlaybackSignerClient>
> {}
export const PlaybackSigner = Binding.Service<PlaybackSigner>("Mux.Video.PlaybackSigner");

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

const encodeJson = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)));

const derLength = (length: number) => {
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  for (let n = length; n > 0; n >>= 8) bytes.unshift(n & 0xff);
  return [0x80 | bytes.length, ...bytes];
};

const der = (tag: number, body: Uint8Array): Uint8Array<ArrayBuffer> =>
  new Uint8Array([tag, ...derLength(body.length), ...body]);

/** RSA AlgorithmIdentifier (rsaEncryption OID + NULL), for wrapping PKCS#1 in PKCS#8. */
const RSA_ALGORITHM = new Uint8Array([
  0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
]);

/** Mux returns base64 of a PEM. WebCrypto needs PKCS#8 DER, so PKCS#1 keys are wrapped. */
const privateKeyToPkcs8 = (base64Pem: string): Uint8Array<ArrayBuffer> => {
  const pem = atob(base64Pem);
  const body = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const keyDer = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  if (!pem.includes("BEGIN RSA PRIVATE KEY")) return keyDer;
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  return der(0x30, new Uint8Array([...version, ...RSA_ALGORITHM, ...der(0x04, keyDer)]));
};

/**
 * Signs a Mux playback token with a signing key's id and base64 private
 * key, for code that runs without the `PlaybackSigner` binding.
 */
export const signPlaybackToken = async (
  key: { id: string; privateKey: string },
  playbackId: string,
  options: SignOptions = {},
): Promise<string> => {
  const header = encodeJson({ alg: "RS256", typ: "JWT", kid: key.id });
  const payload = encodeJson({
    sub: playbackId,
    aud: AUDIENCE[options.type ?? "video"],
    exp: Math.floor(Date.now() / 1000) + (options.expiresIn ?? 3600),
    kid: key.id,
    ...(options.playbackRestrictionId && {
      playback_restriction_id: options.playbackRestrictionId,
    }),
    ...options.claims,
  });
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    privateKeyToPkcs8(key.privateKey),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${base64url(new Uint8Array(signature))}`;
};

/**
 * `PlaybackSigner` for any host: the key reaches the host through its
 * runtime context, and tokens are signed in the runtime.
 *
 * @layer
 * @provides Mux.Video.PlaybackSigner
 */
export const PlaybackSignerLive = Layer.succeed(
  PlaybackSigner,
  Effect.fn(function* (key: SigningKey) {
    const bound = yield* bindHostEnv(key.FQN, {
      SIGNING_KEY_ID: key.id,
      SIGNING_PRIVATE_KEY: key.private_key,
    });
    const id = bound?.SIGNING_KEY_ID;
    const privateKey = bound?.SIGNING_PRIVATE_KEY;
    return {
      sign: (playbackId, options) =>
        typeof id === "string" && Redacted.isRedacted(privateKey)
          ? Effect.tryPromise({
              try: () =>
                signPlaybackToken(
                  { id, privateKey: Redacted.value(privateKey) as string },
                  playbackId,
                  options,
                ),
              catch: (cause) => new PlaybackTokenError({ reason: "signing failed", cause }),
            })
          : Effect.fail(
              new PlaybackTokenError({
                reason: `signing key ${key.LogicalId} is not bound to this host`,
              }),
            ),
    } satisfies PlaybackSignerClient;
  }),
);
