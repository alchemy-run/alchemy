import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { bindHostEnv } from "../internal/hostEnv.ts";
import type { Webhook } from "./Webhook.ts";

/** A request's `mux-signature` header did not prove it came from Mux. */
export class WebhookSignatureInvalid extends Data.TaggedError("Mux.WebhookSignatureInvalid")<{
  readonly reason: string;
}> {
  override get message() {
    return `Mux webhook signature rejected: ${this.reason}`;
  }
}

export interface VerifyOptions {
  /**
   * Reject signatures older than this many seconds.
   * @default 300
   */
  toleranceSeconds?: number;
  /**
   * Clock override, in Unix seconds.
   * @default the current time
   */
  now?: number;
}

export interface WebhookVerifierClient {
  /**
   * Checks the `mux-signature` header against the raw request body. Pass the
   * body exactly as received: re-serialized JSON does not verify.
   */
  verify: (
    rawBody: string,
    signatureHeader: string | null | undefined,
    options?: VerifyOptions,
  ) => Effect.Effect<void, WebhookSignatureInvalid, RuntimeContext>;
}

/**
 * Verifies that webhook requests came from Mux, with a `Mux.System.Webhook`'s
 * signing secret. The secret reaches the host through its environment when
 * it deploys, as a secret, and requests are checked in the runtime with
 * WebCrypto: no Mux API is called and no Mux access token is needed. Mux
 * signs each request with the secret alone, so there is no workload identity
 * to use instead.
 * @see https://www.mux.com/docs/core/verify-webhook-signatures
 *
 * **Example:** Accept only Mux's requests in a Docker service
 * ```typescript
 * const Hook = Mux.System.Webhook("Events", {
 *   address: "https://api.example.com/mux/events",
 * });
 *
 * export default class Api extends Docker.Service<Api>()(
 *   "Api",
 *   { main: import.meta.filename, port: 3000 },
 *   Effect.gen(function* () {
 *     const hook = yield* Hook;
 *     const verifier = yield* Mux.System.WebhookVerifier(hook);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const request = yield* HttpServerRequest;
 *         const body = yield* request.text;
 *         yield* verifier.verify(body, request.headers["mux-signature"]);
 *         return HttpServerResponse.text("ok");
 *       }).pipe(
 *         Effect.catchTag("Mux.WebhookSignatureInvalid", () =>
 *           Effect.succeed(HttpServerResponse.text("bad signature", { status: 401 })),
 *         ),
 *         Effect.orDie,
 *       ),
 *     };
 *   }).pipe(Effect.provide(Mux.System.WebhookVerifierLive)),
 * ) {}
 * ```
 *
 * Without a binding, `verifyWebhookSignature` checks a request against a
 * secret you pass yourself.
 *
 * @binding
 */
export interface WebhookVerifier extends Binding.Service<
  WebhookVerifier,
  "Mux.System.WebhookVerifier",
  (webhook: Webhook) => Effect.Effect<WebhookVerifierClient>
> {}
export const WebhookVerifier = Binding.Service<WebhookVerifier>("Mux.System.WebhookVerifier");

const hmacHex = async (secret: string, payload: string) => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0")).join("");
};

const constantTimeEqual = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

/**
 * Checks a Mux webhook signature, for code that runs without the
 * `WebhookVerifier` binding. Resolves to `undefined` when the signature is
 * valid, or to the reason it is not.
 */
export const verifyWebhookSignature = async (
  secret: string,
  rawBody: string,
  header: string | null | undefined,
  { toleranceSeconds = 300, now = Math.floor(Date.now() / 1000) }: VerifyOptions = {},
): Promise<string | undefined> => {
  if (!header) return "missing mux-signature header";
  const parts = header.split(",").map((part) => part.split("="));
  const timestamp = Number(parts.find(([k]) => k === "t")?.[1]);
  const signatures = parts.filter(([k]) => k === "v1").map(([, v]) => v ?? "");
  if (!Number.isInteger(timestamp)) return "no timestamp in mux-signature header";
  if (signatures.length === 0) return "no v1 signature in mux-signature header";
  if (Math.abs(now - timestamp) > toleranceSeconds) return "timestamp outside tolerance";
  const expected = await hmacHex(secret, `${timestamp}.${rawBody}`);
  return signatures.some((sig) => constantTimeEqual(sig, expected))
    ? undefined
    : "signature mismatch";
};

/**
 * `WebhookVerifier` for any host: the signing secret reaches the host
 * through its runtime context, and requests are checked in the runtime.
 *
 * @layer
 * @provides Mux.System.WebhookVerifier
 */
export const WebhookVerifierLive = Layer.succeed(
  WebhookVerifier,
  Effect.fn(function* (webhook: Webhook) {
    const bound = yield* bindHostEnv(webhook.FQN, {
      WEBHOOK_SIGNING_SECRET: webhook.signing_secret,
    });
    const secret = bound?.WEBHOOK_SIGNING_SECRET;
    return {
      verify: (rawBody, header, options) =>
        Redacted.isRedacted(secret)
          ? Effect.tryPromise({
              try: () =>
                verifyWebhookSignature(Redacted.value(secret) as string, rawBody, header, options),
              catch: () => new WebhookSignatureInvalid({ reason: "verification failed" }),
            }).pipe(
              Effect.flatMap((reason) =>
                reason === undefined
                  ? Effect.void
                  : Effect.fail(new WebhookSignatureInvalid({ reason })),
              ),
            )
          : Effect.fail(
              new WebhookSignatureInvalid({
                reason: `signing secret of ${webhook.LogicalId} is not bound to this host`,
              }),
            ),
    } satisfies WebhookVerifierClient;
  }),
);
